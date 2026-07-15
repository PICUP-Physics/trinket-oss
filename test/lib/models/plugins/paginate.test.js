const plugin = require('../../../../lib/models/plugins/paginate');

describe('paginate plugin', function() {
  let query, model, schema, options;

  beforeEach(function() {
    query = {
      sort:   vi.fn(function() { return query; }),
      limit:  vi.fn(function() { return query; }),
      select: vi.fn(function() { return query; }),
      exec:   vi.fn(function(cb) { return query; })
    };
    model = {
      find: vi.fn(function() { return query; }),
    };
    schema  = { statics: {} };
    options = {};
  });

  function callPaginate(options, cb) {
    return schema.statics.paginate.call(model, options, cb);
  }

  describe('instantiation', function() {
    function shouldWork() {
      let err;
      try {
        plugin(schema, options);
      } catch(e) {
        err = e;
      }
      expect(err == null).toBe(true);
    }

    it('should require a sortBy option', function() {
      let err;

      try {
        plugin(schema, options);
      }
      catch(e) {
        err = e.toString();
      }
      expect(err != null).toBe(true);
      expect(err).toMatch(/requires.*sort\skey/i);
    });

    it('should accept a single sortBy option as a string', function() {
      options.sortBy = 'foo';
      shouldWork();
    });

    it('should accept a single sortBy option as an array', function() {
      options.sortBy = ['foo'];
      shouldWork();
    });

    it('should accept multiple sortBy options as an array', function() {
      options.sortBy = ['foo', 'bar'];
      shouldWork();
    });

    it('should not allow a default limit above the max limit', function() {
      let err;
      options.sortBy = 'foo';
      options.defaultLimit = 100;
      options.maxLimit     = 1;
      try {
        plugin(schema, options);
      }
      catch(e) {
        err = e;
      }
      expect(err != null).toBe(true);
      expect(err.message).toMatch(/default.*limit.*exceed.*max.*limit/i);
    });

    it('should provide a paginate method when all valid options are supplied', function() {
      options.sortBy = 'foo';
      options.defaultLimit = 1;
      options.maxLimit = 2;
      shouldWork();
      expect(schema.statics.paginate != null).toBe(true);
      expect(schema.statics.paginate).toBeInstanceOf(Function);
    });
  });

  describe('usage', function() {
    it('should return an unexecuted query if no callback is provided', function() {
      options.sortBy = 'foo';
      plugin(schema, options);
      const result = callPaginate();
      expect(result).toBe(query);
      expect(query.exec).not.toHaveBeenCalled();
    });

    it('should execute the query if a callback is provided', function() {
      options.sortBy = 'foo';
      plugin(schema, options);
      const cb = vi.fn();
      callPaginate(cb);
      expect(query.exec).toHaveBeenCalledWith(cb);
    });

    it('should die if an invalid sort key is provided', function() {
      let err;
      options.sortBy = 'foo';
      plugin(schema, options);
      try {
        callPaginate({
          sort : 'bar'
        });
      } catch(e) {
        err = e;
      }

      expect(err != null).toBe(true);
      expect(err.message).toMatch(/sort.*key.*not.*allowed/i);
    });

    describe('query instantiation', function() {
      it('should create a query via find', function() {
        options.sortBy = 'foo';
        plugin(schema, options);
        callPaginate();
        expect(model.find).toHaveBeenCalledOnce();
      });

      it('should construct a default condition if none is provided', function() {
        options.sortBy = 'foo';
        plugin(schema, options);
        callPaginate();
        expect(model.find).toHaveBeenCalledWith({foo:{'$exists':true}});
      });

      it('should use the where option as the query if it is provided', function() {
        const whereClause = { a : 'b' },
              expectedQuery = {
                a : 'b',
                foo : {'$exists' : true}
              };

        options.sortBy = 'foo';
        plugin(schema, options);
        callPaginate({
          where : whereClause
        });
        expect(model.find).toHaveBeenCalledWith(expectedQuery);
      });

      it('should add an after condition to the query if it is provided', function() {
        const whereClause = { a : 'b' };
        options.sortBy = 'foo';
        plugin(schema, options);
        callPaginate({
          where : whereClause,
          after : 1
        });
        expect(model.find).toHaveBeenCalledWith({
          foo : { '$exists': true, '$gt' : 1 },
          a   : 'b'
        });
      });
    });

    describe('sorting', function() {
      it('should modify the query with a sort', function() {
        options.sortBy = 'foo';
        plugin(schema, options);
        callPaginate();
        expect(query.sort).toHaveBeenCalledOnce();
      });

      it('should by default sort ascending by the default sortBy value', function() {
        options.sortBy = 'foo';
        plugin(schema, options);
        callPaginate();
        expect(query.sort).toHaveBeenCalledWith({
          foo : 1
        });
      });

      it('should sort ascending if the provided sort is positive', function() {
        options.sortBy = 'foo';
        plugin(schema, options);
        callPaginate({
          sort : 'foo'
        });
        expect(query.sort).toHaveBeenCalledWith({
          foo : 1
        });
      });

      it('should sort descending if the provided sort is negative', function() {
        options.sortBy = 'foo';
        plugin(schema, options);
        callPaginate({
          sort : '-foo'
        });
        expect(query.sort).toHaveBeenCalledWith({
          foo : -1
        });
      });
    });

    describe('limiting', function() {
      it('should modify the query with a limit', function() {
        options.sortBy = 'foo';
        plugin(schema, options);
        callPaginate();
        expect(query.limit).toHaveBeenCalledOnce();
      });

      it('should use the default limit if none is provided', function() {
        options.sortBy = 'foo';
        options.defaultLimit = 5;
        plugin(schema, options);
        callPaginate();
        expect(query.limit).toHaveBeenCalledWith(options.defaultLimit);
      });

      it('should use the supplied limit', function() {
        options.sortBy = 'foo';
        plugin(schema, options);
        callPaginate({limit:2});
        expect(query.limit).toHaveBeenCalledWith(2);
      });

      it('should not allow the supplied limit to exceed the max limit', function() {
        let err;
        options.sortBy = 'foo';
        options.defaultLimit = 1;
        options.maxLimit = 5;
        plugin(schema, options);
        try {
          callPaginate({limit:6});
        } catch(e) {
          err = e;
        }

        expect(err != null).toBe(true);
        expect(err.message).toMatch(/limit.*less.*than.*max.*limit/i);
      });
    });
  });
});
