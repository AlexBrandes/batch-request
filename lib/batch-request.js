// Batch Request

var _ = require('lodash'),
    check = require('validator').check,
    methods = require('methods'),
    Promise = require('bluebird'),
    request = Promise.promisify(require('request')),
    url = require('url');

function getFinalUrl(req, r) {
    // Accept either uri or url (this is what request does, we just mirror)
    r.url = r.url || r.uri;

    // Convert relative paths to full paths
    if (typeof r.url === 'string' && /^\//.test(r.url) === true) {
        var protocol = req.protocol;

        if( process.env.FORCE_SSL !== undefined && process.env.FORCE_SSL === 'true' ) {
            protocol = 'https';
        }

        return protocol + '://' + req.get('host') + r.url;
    }

    return r.url;
}

var batchRequest = function(params) {

    // Set default option values
    params = params || {};
    params.localOnly = (typeof params.localOnly === 'undefined') ? true : params.localOnly;
    params.httpsAlways = (typeof params.localOnly === 'undefined') ? false : params.localOnly;
    params.max = (typeof params.max === 'undefined') ? 20 : params.max;
    params.validateRespond = (typeof params.validateRespond === 'undefined') ? true : params.validateRespond;
    params.allowedHosts = (typeof params.allowedHosts === 'undefined') ? null : params.allowedHosts;
    params.defaultHeaders = (typeof params.defaultHeaders === 'undefined') ? {} : params.defaultHeaders;
    params.forwardHeaders = (typeof params.forwardHeaders === 'undefined') ? [] : params.forwardHeaders;
    params.postBatch = (typeof params.postBatch === 'undefined') ? function() {} : params.postBatch;
    params.validateErrorHandler = (typeof params.validateErrorHandler === 'undefined') ? function() {} : params.validateErrorHandler;
    params.omitResponseHeaders = (typeof params.omitResponseHeaders === 'undefined') ? [] : params.omitResponseHeaders;

    var _prepareRequest = function( req, r, rp ) {
        r.headers = r.headers || {};

        r.uri = r.url = getFinalUrl(req, r);
        if( rp ) {
            var dependencyParameterRegex = /{([A-Za-z]+)}/g;

            var match = dependencyParameterRegex.exec( r.url );
            while (match != null) {

                var urlPreReplacement = r.url.substring( 0, match.index );
                var urlReplacement = rp.body[ match[1] ];
                var urlPostReplacement = r.url.substring( match.index + match[0].length );

                r.uri = r.url = urlPreReplacement + urlReplacement + urlPostReplacement;

                match = dependencyParameterRegex.exec( rp.body );
            }
        }

        _.each(params.defaultHeaders, function(headerV, headerK) {
            if (!(headerK in r.headers)) { // copy defaults if not already exposed
                r.headers[headerK] = headerV;
            }
        });
        _.each(params.forwardHeaders, function(headerK) {
            if (!(headerK in r.headers) && headerK in req.headers) { // copy forward if not already exposed
                var forwardValue = req.headers[headerK];
                r.headers[headerK] = forwardValue;
            }
        });
        console.log( '_prepareRequest', r );
        return r;
    };

    var batch = function(req, res, next) {
        // Here we assume it the request has already been validated, either by
        // our included middleware or otherwise by the app developer.

        // We also assume it has been run through some middleware like
        // express.bodyParser() or express.json() to parse the requests

        var requests = req.body;

        // First, let's fire off all calls without any dependencies, accumulate their promises
        var requestPromises = _.reduce(requests, function(promises, r, key) {
            if (!r.dependency || r.dependency === 'none') {
                _prepareRequest( req, r );

                promises[key] = request(r).spread(function(response, body) {
                    if( typeof body === 'string' && /application\/json/.test( response.headers[ 'content-type' ] ) ) {
                        body = JSON.parse( body );
                    }

                    return {
                        'statusCode': response.statusCode,
                        'body': body,
                        'headers': response.headers
                    };
                });
            }
            // And while we do that, build the dependency object with those items as keys
            // { key: Promise }
            return promises;
        }, {});

        // Then recursively iterate over all items with dependencies, resolving some at each pass
        var recurseDependencies = function (reqs) {
            // End state hit when the number of promises we have matches the number
            // of request objects we started with.
            if (_.size(requestPromises) >= _.size(reqs)) {
                return;
            } else {
                _.each(requestPromises, function(rp, key) {
                    var dependentKey = null;
                    var dependent = _.find(reqs, function(request, dKey) {
                        dependentKey = dKey;
                        return request.dependency === key && (typeof requestPromises[dKey] === 'undefined');
                    });
                    if (dependent) {
                        requestPromises[dependentKey] = rp.then(function( response ) {
                            if( response.statusCode !== 200 ) {
                                dependent = _prepareRequest( req, dependent );
                            } else {
                                dependent = _prepareRequest( req, dependent, response );
                            }
                            return request(dependent);
                        }).spread(function(response, body) {
                            return response;
                        });
                    }
                });
                recurseDependencies(reqs);
            }
        };

        // Recurse dependencies
        recurseDependencies(requests);

        // Wait for all to complete before responding
        Promise
            .props(requestPromises).then(function(result) {

                // remove all properties, except status, body, and headers
                var output = {};
                for(var prop in result){
                    output[prop] = {
                        statusCode: result[prop].statusCode,
                        body: result[prop].body
                    };
                    var output_headers = _.omit( result[prop].headers, params.omitResponseHeaders )
                    console.log( 'output_headers', output_headers );
                    if( Object.keys( output_headers ).length !== 0 ) {
                        output[prop].headers = output_headers;
                    }
                }
                res.json(output);
                params.postBatch(req, res);
                // next(); // this line is causing the response to be 0
            })
            .catch(function(error) {
                next(error);
            });
    };

    batch.validate = function(req, res, next) {
        var err = null,
            requests = req.body,
            requestHost;

        // Validation on Request object as a whole
        try {
            check(_.size(requests), 'Cannot make a batch request with an empty request object').min(1);
            check(_.size(requests), 'Over the max request limit. Please limit batches to ' + params.max + ' requests').max(params.max);
            if (req.method === 'POST' && !req.is('json')) {
                throw new Error('Batch Request will only accept body as json');
            }
        } catch (e) {
            err = {
                error: {
                    'message': e.message,
                    'type': 'ValidationError'
                }
            };
        }

        // Validation on each request object
        _.each(requests, function(r, key) {

            // If no method provided, default to GET
            r.method = (typeof r.method === 'string') ? r.method.toLowerCase() : 'get';

            r.url = getFinalUrl(req, r);

            try {
                check(r.url, 'Invalid URL').isUrl();
                check(r.method, 'Invalid method').isIn(methods);
                if (r.body !== undefined) {
                    check(r.method.toLowerCase(), 'Request body not allowed for this method').isIn(['put', 'post', 'options']);
                }
            } catch (e) {
                err = {
                    error: {
                        'message': e.message,
                        'request': key,
                        'type': 'ValidationError'
                    }
                };
            }

            if (params.allowedHosts !== null) {
                requestHost = url.parse(r.url).host;
                if (params.allowedHosts.indexOf(requestHost) === -1) {
                    err = {
                        error: {
                            'message': 'Cannot make batch request to a host which is not allowed',
                            'host': requestHost,
                            'type': 'ValidationError'
                        }
                    };
                }
            }
        });

        if (err !== null) {
            if( params.validateErrorHandler ) {
                params.validateErrorHandler( err, res, next );
            } else {
                res.send(400, err);
                next(err);
            }
        } else {
            next();
        }
    };

    return batch;
};

module.exports = batchRequest;
