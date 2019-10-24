const Apify = require('apify');
const requestPromise = require('request-promise');
const _ = require('lodash');

const fetch = require('@zeit/fetch-retry')(require('node-fetch'));
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const minify = require('html-minifier').minify;

const {
    tools,
    constants: { META_KEY },
} = require('@apify/scraper-tools');

const SCHEMA = require('../INPUT_SCHEMA');
const { utils: { log } } = Apify;

/**
 * Replicates the INPUT_SCHEMA with JavaScript types for quick reference
 * and IDE type check integration.
 *
 * @typedef {Object} Input
 * @property {Object[]} startUrls
 * @property {boolean} useRequestQueue
 * @property {Object[]} pseudoUrls
 * @property {string} linkSelector
 * @property {boolean} keepUrlFragments
 * @property {string} pageFunction
 * @property {Object} proxyConfiguration
 * @property {boolean} debugLog
 * @property {number} maxRequestRetries
 * @property {number} maxPagesPerCrawl
 * @property {number} maxResultsPerCrawl
 * @property {number} maxCrawlingDepth
 * @property {number} maxConcurrency
 * @property {number} handleRequestTimeoutSecs
 * @property {Object} customData
 */

/**
 * Holds all the information necessary for constructing a crawler
 * instance and creating a context for a pageFunction invocation.
 */
class CrawlerSetup {
    /* eslint-disable class-methods-use-this */
    constructor(input) {
        this.name = 'Web Scraper';
        // Set log level early to prevent missed messages.
        if (input.debugLog) log.setLevel(log.LEVELS.DEBUG);

        // Keep this as string to be immutable.
        this.rawInput = JSON.stringify(input);

        // Attempt to load page function from disk if not present on input.
        tools.maybeLoadPageFunctionFromDisk(input, __dirname);

        // Validate INPUT if not running on Apify Cloud Platform.
        if (!Apify.isAtHome()) tools.checkInputOrThrow(input, SCHEMA);

        /**
         * @type {Input}
         */
        this.input = input;
        this.env = Apify.getEnv();

        // Validations
        if (this.input.pseudoUrls.length && !this.input.useRequestQueue) {
            throw new Error('Cannot enqueue links using Pseudo URLs without using a Request Queue. '
                + 'Either select the "Use Request Queue" option to enable Request Queue or '
                + 'remove your Pseudo URLs.');
        }
        this.input.pseudoUrls.forEach((purl) => {
            if (!tools.isPlainObject(purl)) throw new Error('The pseudoUrls Array must only contain Objects.');
            if (purl.userData && !tools.isPlainObject(purl.userData)) throw new Error('The userData property of a pseudoUrl must be an Object.');
        });
        this.pageFunction = tools.evalFunctionOrThrow(this.input.pageFunction);

        // Initialize async operations.
        this.crawler = null;
        this.requestList = null;
        this.requestQueue = null;
        this.dataset = null;
        this.keyValueStore = null;
        this.initPromise = this._initializeAsync();
    }

    async _initializeAsync() {
        // RequestList
        const startUrls = this.input.startUrls.map((req) => {
            req.useExtendedUniqueKey = true;
            req.keepUrlFragment = this.input.keepUrlFragments;
            return req;
        });
        this.requestList = await Apify.openRequestList('WEB_SCRAPER', startUrls);

        // RequestQueue if selected
        if (this.input.useRequestQueue) this.requestQueue = await Apify.openRequestQueue();

        // Dataset
        this.dataset = await Apify.openDataset();
        const { itemsCount } = await this.dataset.getInfo();
        this.pagesOutputted = itemsCount || 0;

        // KeyValueStore
        this.keyValueStore = await Apify.openKeyValueStore();
    }

    /**
     * Resolves to a `BasicCrawler` instance.
     * constructor.
     * @returns {Promise<BasicCrawler>}
     */
    async createCrawler() {
        await this.initPromise;

        const options = {
            handleRequestFunction: this._handleRequestFunction.bind(this),
            requestList: this.requestList,
            requestQueue: this.requestQueue,
            handleFailedRequestFunction: this._handleFailedRequestFunction.bind(this),
            handleRequestTimeoutSecs: this.input.handleRequestTimeoutSecs,
            maxConcurrency: this.input.maxConcurrency,
            maxRequestRetries: this.input.maxRequestRetries,
            maxRequestsPerCrawl: this.input.maxPagesPerCrawl,
            proxyUrls: this.input.proxyConfiguration.proxyUrls,
        };

        this.crawler = new Apify.BasicCrawler(options);

        return this.crawler;
    }

    _handleFailedRequestFunction({ request }) {
        const lastError = request.errorMessages[request.errorMessages.length - 1];
        const errorMessage = lastError ? lastError.split('\n')[0] : 'no error';
        log.error(`Request ${request.url} failed and will not be retried anymore. Marking as failed.\nLast Error Message: ${errorMessage}`);
        return this._handleResult(request, {}, null, true);
    }

    /**
     * First of all, it initializes the state that is exposed to the user via
     * `pageFunction` context.
     *
     * Then it invokes the user provided `pageFunction` with the prescribed context
     * and saves its return value.
     *
     * Finally, it makes decisions based on the current state and post-processes
     * the data returned from the `pageFunction`.
     * @param {Object} environment
     * @returns {Function}
     */
    async _handleRequestFunction({ request, response, autoscaledPool }) {
        const start = process.hrtime();

        /**
         * PRE-PROCESSING
         */
        // Make sure that an object containing internal metadata
        // is present on every request.
        tools.ensureMetaData(request);

        // Abort the crawler if the maximum number of results was reached.
        const aborted = await this._handleMaxResultsPerCrawl(autoscaledPool);
        if (aborted) return;

        let $, pageResult;

        // Fetch the page HTML
        pageResult = await requestPromise(request.url);

        if ( this.input.XML ) {
            $ = cheerio.load(pageResult, {
                normalizeWhitespace: true,
                xmlMode: true
            });
        } else {
            $ = cheerio.load(pageResult);
        }

        /**
         * USER FUNCTION EXECUTION
         */
        tools.logPerformance(request, 'handlePageFunction PREPROCESSING', start);
        const startUserFn = process.hrtime();

        const context = {
          $, 
          request, 
          pageResult, 
          cheerio,
          _, 
          log, 
          input: this.input,
          fetch,
          minify,
          Apify,
        };
        let output = {};
        try {
            output.pageFunctionResult = await this.pageFunction(context);
        } catch (err) {
            output.pageFunctionError = Object.getOwnPropertyNames(err)
                .reduce((memo, name) => {
                    memo[name] = err[name];
                    return memo;
                }, {});
        }
        // // This needs to be added after pageFunction has run.
        // output.requestFromBrowser = context.request;

        /**
         * Since Dates cannot travel back to Node and Puppeteer does not use .toJSON
         * to stringify, they come back as empty objects. We could use JSON.stringify
         * ourselves, but that exposes us to overridden .toJSON in the target websites.
         * This hack is not ideal, but it avoids both problems.
         */
        function replaceAllDatesInObjectWithISOStrings(obj) {
            for (const [key, value] of Object.entries(obj)) {
                if (value instanceof Date && typeof value.toISOString === 'function') {
                    obj[key] = value.toISOString();
                } else if (value && typeof value === 'object') {
                    replaceAllDatesInObjectWithISOStrings(value);
                }
            }
            return obj;
        }
        output = replaceAllDatesInObjectWithISOStrings(output);

        tools.logPerformance(request, 'handlePageFunction USER FUNCTION', startUserFn);
        const finishUserFn = process.hrtime();

        /**
         * POST-PROCESSING
         */
        const { pageFunctionResult, /* requestFromBrowser,*/ pageFunctionError } = output;
        // // Merge requestFromBrowser into request to preserve modifications that
        // // may have been made in browser context.
        // Object.assign(request, requestFromBrowser);

        // Throw error from pageFunction, if any.
        if (pageFunctionError) throw tools.createError(pageFunctionError);

        // Enqueue more links if a link selector is available,
        // unless maxCrawlingDepth would be exceeded.
        await this._handleLinks($, request);

        // Save the `pageFunction`s result (or just metadata) to the default dataset.
        await this._handleResult(request, response, pageFunctionResult);

        tools.logPerformance(request, 'handlePageFunction POSTPROCESSING', finishUserFn);
        tools.logPerformance(request, 'handlePageFunction EXECUTION', start);
    }

    async _handleMaxResultsPerCrawl(autoscaledPool) {
        if (!this.input.maxResultsPerCrawl || this.pagesOutputted < this.input.maxResultsPerCrawl) return false;
        log.info(`User set limit of ${this.input.maxResultsPerCrawl} results was reached. Finishing the crawl.`);
        await autoscaledPool.abort();
        return true;
    }

    async _handleLinks($, request) {
        if (!(this.input.linkSelector && this.requestQueue)) return;
        const start = process.hrtime();

        const currentDepth = request.userData[META_KEY].depth;
        const hasReachedMaxDepth = this.input.maxCrawlingDepth && currentDepth >= this.input.maxCrawlingDepth;
        if (hasReachedMaxDepth) {
            log.debug(`Request ${request.url} reached the maximum crawling depth of ${currentDepth}.`);
            return;
        }

        const enqueueOptions = {
            $,
            selector: this.input.linkSelector,
            pseudoUrls: this.input.pseudoUrls,
            requestQueue: this.requestQueue,
            transformRequestFunction: (requestOptions) => {
                requestOptions.userData = {
                    [META_KEY]: {
                        parentRequestId: request.id || request.uniqueKey,
                        depth: currentDepth + 1,
                    },
                };
                requestOptions.useExtendedUniqueKey = true;
                requestOptions.keepUrlFragment = this.input.keepUrlFragments;
                return requestOptions;
            },
        };

        await Apify.utils.enqueueLinks(enqueueOptions);

        tools.logPerformance(request, 'handleLinks EXECUTION', start);
    }

    async _handleResult(request, response, pageFunctionResult, isError) {
        const start = process.hrtime();
        const payload = tools.createDatasetPayload(request, response, pageFunctionResult, isError);
        await Apify.pushData(payload);
        this.pagesOutputted++;
        tools.logPerformance(request, 'handleResult EXECUTION', start);
    }
}

module.exports = CrawlerSetup;
