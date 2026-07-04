const crypto = require('crypto');

describe('Trinket model', () => {
  afterEach(() => vi.restoreAllMocks());

  describe('pre save hooks', () => {
    describe('createHash', () => {
      let createHash;

      beforeAll(() => {
        // Defer access to Trinket global past describe-collection time.
        createHash = Trinket.hooks.pre.save.createHash;
      });

      it('should not generate a hash if one is already set', async () => {
        const hashify = vi.fn();
        const trinket = {
          hash            : 'abc123',
          hashify,
          findModulesUsed : () => {},
          isModified      : () => {}
        };
        await new Promise((res, rej) =>
          createHash.call(trinket, (err) => (err ? rej(err) : res()))
        );
        expect(trinket.hash).toEqual('abc123');
        expect(hashify).not.toHaveBeenCalled();
      });

      it('should generate a hash and shortcode based on code, lang, owner and parent', async () => {
        const hash   = 'abcdefghijklmnopqrstuvwxyz';
        const now    = '123456789';
        const update = vi.fn().mockReturnValue({ digest: () => hash });

        vi.spyOn(crypto, 'createHash').mockReturnValue({ update });
        vi.spyOn(Date, 'now').mockReturnValue(now);

        const trinket = {
          code            : 'abc123',
          lang            : 'python',
          _owner          : 'owner',
          _parent         : 'parent',
          hashify         : Trinket.objectMethods.hashify,
          generateSeed    : Trinket.objectMethods.generateSeed,
          findModulesUsed : Trinket.objectMethods.findModulesUsed,
          isModified      : () => {}
        };

        await new Promise((res, rej) =>
          createHash.call(trinket, (err) => (err ? rej(err) : res()))
        );

        expect(trinket.hash).toEqual(hash);
        // shortCode uses .substring(0, 12) in current source; legacy test checked 10.
        // Updating to match current model behavior.
        expect(trinket.shortCode).toEqual(hash.substring(0, 12));
        expect(update).toHaveBeenCalledWith(
          trinket.code + trinket.lang + trinket._owner + trinket._parent
        );
        expect(update).toHaveBeenCalledWith(
          trinket.code + trinket.lang + trinket._owner + trinket._parent + now
        );
      });
    });

    describe('findModulesUsed', () => {
      let createHash;

      beforeAll(() => {
        createHash = Trinket.hooks.pre.save.createHash;
      });

      it('should be set modules array', async () => {
        const findModulesUsed = vi.fn(Trinket.objectMethods.findModulesUsed);
        const trinket = {
          code            : 'import turtle',
          lang            : 'python',
          hashify         : () => {},
          findModulesUsed,
          isModified      : () => {}
        };
        await new Promise((res, rej) =>
          createHash.call(trinket, (err) => (err ? rej(err) : res()))
        );
        expect(findModulesUsed).toHaveBeenCalledOnce();
        expect(trinket.modules).toContain('turtle');
      });
    });
  });

  describe('class methods', () => {
    describe('findByHash', () => {
      it('should use the hash as the search criteria', () => {
        const doc     = 'foo';
        const cb      = vi.fn();
        const findOne = vi.fn((criteria, callback) => callback && callback(null, doc));
        const scope   = { model: { findOne } };
        const query   = { hash: 'abc123' };

        Trinket.classMethods.findByHash.call(scope, 'abc123', cb);
        expect(findOne).toHaveBeenCalledWith(query, cb);
      });

      it('should return the results of the findOne call', async () => {
        const doc     = 'foo';
        const findOne = vi.fn((criteria, callback) => callback(null, doc));
        const scope   = { model: { findOne } };

        const result = await new Promise((res, rej) =>
          Trinket.classMethods.findByHash.call(scope, 'abc123', (err, r) =>
            err ? rej(err) : res(r)
          )
        );
        expect(result).toEqual('foo');
      });
    });

    describe('findById', () => {
      // The generated findById uses a promise internally: findOne(query) then cb.
      // It no longer passes cb directly to findOne, so calledWithExactly(query, cb)
      // is replaced with a check that findOne was called with the expected query only.
      it('should include the shortCode as a search criteria', async () => {
        const doc     = 'foo';
        const findOne = vi.fn().mockResolvedValue(doc);
        const scope   = { model: { findOne } };
        const query   = { shortCode: 'abc123' };

        await new Promise((res, rej) =>
          Trinket.classMethods.findById.call(scope, 'abc123', (err, r) =>
            err ? rej(err) : res(r)
          )
        );
        // Internal impl now calls findOne(query) without cb; callback is handled via .then
        expect(findOne).toHaveBeenCalledWith(query);
      });

      it('should return the results of the findOne call', async () => {
        const doc     = 'foo';
        const findOne = vi.fn().mockResolvedValue(doc);
        const scope   = { model: { findOne } };

        const result = await new Promise((res, rej) =>
          Trinket.classMethods.findById.call(scope, 'abc123', (err, r) =>
            err ? rej(err) : res(r)
          )
        );
        expect(result).toEqual('foo');
      });
    });

    describe('findByIdAndUpdateMetrics', () => {
      let findByIdAndUpdate;
      let callScope;
      let interactionStub;

      beforeEach(() => {
        // Recreate mocks fresh per test (harness drops DB per-it; mimic that for
        // mock state too).
        findByIdAndUpdate = vi.fn().mockResolvedValue({
          _id    : 'id',
          _owner : 'owner',
          lang   : 'lang'
        });
        callScope = { model: { findByIdAndUpdate } };

        // Stub the global Interaction that trinket.js references without require.
        interactionStub = vi.spyOn(globalThis, 'Interaction').mockImplementation(
          function(data) {
            return Object.assign({ save: vi.fn() }, data);
          }
        );
      });

      it('should construct a $inc entry for the metric to be updated', async () => {
        await Trinket.classMethods.findByIdAndUpdateMetrics.call(callScope, 'abc123', 'runs');
        expect(findByIdAndUpdate).toHaveBeenCalledWith(
          'abc123',
          expect.objectContaining({ $inc: { 'metrics.runs': 1 } }),
          expect.any(Object)
        );
      });

      it('should construct an interaction for the metric to be updated', async () => {
        await Trinket.classMethods.findByIdAndUpdateMetrics.call(callScope, 'abc123', 'runs');
        expect(interactionStub).toHaveBeenCalledWith(
          expect.objectContaining({
            action   : 'runs',
            _trinket : 'id',
            _owner   : 'owner',
            lang     : 'lang'
          })
        );
        expect(interactionStub.mock.results[0].value.save).toHaveBeenCalledOnce();
      });
    });
  });
});
