var flow    = require('../../helpers/flow'),
    Trinket = require('../../../lib/models/trinket');

module.exports = function() {
  describe('Legacy shortcode redirects', function() {
    var pythonShortCode,
        glowShortCode,
        legacyPython  = 'legacy-python-001',
        legacyGlow    = 'legacy-glow-001',
        legacyDeleted = 'legacy-deleted-001';

    before(function(done) {
      // 1) a normal python trinket created through the API, then stamped
      //    with a legacyShortCode the way an import would have.
      flow.createTrinket(function() {
        pythonShortCode = flow.lastResponse.body.data.shortCode;
        var pythonId    = flow.lastResponse.body.data.id;

        Trinket.findById(pythonId, function(err, doc) {
          if (err) return done(err);
          doc.legacyShortCode = legacyPython;
          doc.save(function(err) {
            if (err) return done(err);

            // 2) a glowscript trinket — proves the redirect uses the
            //    record's own lang (old vpython codes now live as glowscript).
            new Trinket({
              code            : 'GlowScript 3.0',
              lang            : 'glowscript',
              legacyShortCode : legacyGlow
            }).save(function(err, glow) {
              if (err) return done(err);
              glowShortCode = glow.shortCode;

              // 3) a soft-deleted trinket — must resolve to 404.
              new Trinket({
                code            : 'gone',
                lang            : 'python',
                legacyShortCode : legacyDeleted,
                deletedAt       : new Date()
              }).save(function(err) {
                done(err);
              });
            });
          });
        });
      });
    });

    it('redirects a known legacy code to the new trinket page (301)', function(done) {
      flow.get('/legacy/' + legacyPython).end(function(err, res) {
        res.statusCode.should.eql(301);
        res.headers.location.should.eql('/python/' + pythonShortCode);
        done();
      });
    });

    it('builds the target from the record lang (renamed langs land correctly)', function(done) {
      flow.get('/legacy/' + legacyGlow).end(function(err, res) {
        res.statusCode.should.eql(301);
        res.headers.location.should.eql('/glowscript/' + glowShortCode);
        done();
      });
    });

    it('returns 404 for an unknown legacy code', function(done) {
      flow.get('/legacy/does-not-exist').end(function(err, res) {
        res.statusCode.should.eql(404);
        done();
      });
    });

    it('returns 404 when the matched trinket is soft-deleted', function(done) {
      flow.get('/legacy/' + legacyDeleted).end(function(err, res) {
        res.statusCode.should.eql(404);
        done();
      });
    });

    it('redirects a known legacy code to the embed (301)', function(done) {
      flow.get('/legacy/embed/' + legacyPython).end(function(err, res) {
        res.statusCode.should.eql(301);
        res.headers.location.should.eql('/embed/python/' + pythonShortCode);
        done();
      });
    });

    it('returns 404 for an unknown legacy embed code', function(done) {
      flow.get('/legacy/embed/nope').end(function(err, res) {
        res.statusCode.should.eql(404);
        done();
      });
    });
  });
};
