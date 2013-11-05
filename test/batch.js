// Batch tests

process.env.NODE_ENV = 'test';

var Chance = require('chance'),
    chance = new Chance(),
    expect = require('chai').expect,
    request = require('supertest');

var app = require('./helpers/app');

var batch = require('../lib/batch-request')();

describe('batch', function() {
    describe('basic', function() {
        it('looks good', function() {
            expect(batch).to.be.a('function');
        });
    });

    describe('test our app helper', function() {
        it('has a /users/1/name endpoint', function(done) {
            request(app)
                .get('/users/1/name')
                .expect(200, function(err, res) {
                    expect(err).to.not.exist;
                    expect(res.body).to.exist;
                    done();
                });
        });
    });

    describe('basic', function() {
        it('can handle a single request');
        
    });
});

