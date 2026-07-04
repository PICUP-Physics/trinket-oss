'use strict';

var should = require('chai').should();
var backend = require('../../../lib/db/firestore-backend');
var FirestoreDocument         = backend._test.FirestoreDocument;
var extractDefaults           = backend._test.extractDefaults;
var extractSubdocDefaults     = backend._test.extractSubdocDefaults;
var resolvePositionalUpdates  = backend._test.resolvePositionalUpdates;
var resolvePositionalArrayOp  = backend._test.resolvePositionalArrayOp;

// Minimal fake collectionRef — just needs to exist; no methods called in constructor
var fakeRef = {};

// Helper: build a modelSchema from plain defaults + subdocDefaults maps
function makeModelSchema(defaults, subdocDefaults) {
  return {
    _defaults: defaults || {},
    _subdoc_defaults: subdocDefaults || {},
    _refs: {},
    _pre_save_hooks: [],
    _post_save_hooks: [],
    _instance_methods: {}
  };
}

// ---------------------------------------------------------------------------
// extractDefaults
// ---------------------------------------------------------------------------

describe('firestore-backend extractDefaults', function() {
  it('returns empty object for null schema', function() {
    extractDefaults(null).should.deep.equal({});
  });

  it('returns default value for scalar field', function() {
    var schema = { paths: { active: { instance: 'Boolean', defaultValue: true } } };
    extractDefaults(schema).should.deep.equal({ active: true });
  });

  it('returns [] for plain array field', function() {
    var schema = { paths: { tags: { instance: 'Array', $isMongooseArray: true } } };
    extractDefaults(schema).should.deep.equal({ tags: [] });
  });

  it('returns [] for DocumentArray field', function() {
    var schema = {
      paths: {
        users: {
          $isMongooseArray: true,
          schema: {
            paths: { roles: { instance: 'Array', $isMongooseArray: true } }
          }
        }
      }
    };
    var result = extractDefaults(schema);
    result.should.have.property('users');
    result.users.should.deep.equal([]);
  });

  it('ignores fields without defaults', function() {
    var schema = { paths: { name: { instance: 'String', defaultValue: undefined } } };
    extractDefaults(schema).should.deep.equal({});
  });
});

// ---------------------------------------------------------------------------
// extractSubdocDefaults
// ---------------------------------------------------------------------------

describe('firestore-backend extractSubdocDefaults', function() {
  it('returns empty object for null schema', function() {
    extractSubdocDefaults(null).should.deep.equal({});
  });

  it('returns empty object when no DocumentArray fields', function() {
    var schema = {
      paths: {
        name: { instance: 'String', defaultValue: '' },
        tags: { instance: 'Array', $isMongooseArray: true }
      }
    };
    extractSubdocDefaults(schema).should.deep.equal({});
  });

  it('extracts array sub-field defaults', function() {
    var schema = {
      paths: {
        users: {
          $isMongooseArray: true,
          schema: {
            paths: {
              userId:   { instance: 'ObjectID', defaultValue: undefined },
              hideFrom: { instance: 'Array', $isMongooseArray: true },
              roles:    { instance: 'Array', $isMongooseArray: true }
            }
          }
        }
      }
    };
    var result = extractSubdocDefaults(schema);
    result.should.deep.equal({ users: { hideFrom: [], roles: [] } });
  });

  it('extracts scalar sub-field defaults', function() {
    var schema = {
      paths: {
        members: {
          $isMongooseArray: true,
          schema: {
            paths: {
              active: { instance: 'Boolean', defaultValue: false },
              score:  { instance: 'Number',  defaultValue: 0 }
            }
          }
        }
      }
    };
    var result = extractSubdocDefaults(schema);
    result.should.deep.equal({ members: { active: false, score: 0 } });
  });

  it('handles function defaults in subdoc fields', function() {
    var schema = {
      paths: {
        items: {
          $isMongooseArray: true,
          schema: {
            paths: {
              createdAt: { instance: 'Date', defaultValue: function() { return new Date(0); } }
            }
          }
        }
      }
    };
    var result = extractSubdocDefaults(schema);
    result.should.have.property('items');
    result.items.should.have.property('createdAt');
    result.items.createdAt.getTime().should.equal(0);
  });

  it('skips dotted paths', function() {
    var schema = {
      paths: {
        'users.nested': { instance: 'String', defaultValue: 'x', schema: { paths: {} } }
      }
    };
    extractSubdocDefaults(schema).should.deep.equal({});
  });
});

// ---------------------------------------------------------------------------
// FirestoreDocument — subdocument defaults applied in constructor
// ---------------------------------------------------------------------------

describe('FirestoreDocument subdocument defaults', function() {
  it('fills in missing array sub-fields on existing array elements', function() {
    var schema = makeModelSchema(
      { users: [] },
      { users: { hideFrom: [], roles: [] } }
    );
    var doc = new FirestoreDocument(
      { _id: 'doc1', users: [{ userId: 'u1' }] },
      fakeRef,
      schema
    );
    doc.users[0].should.have.property('hideFrom').that.deep.equals([]);
    doc.users[0].should.have.property('roles').that.deep.equals([]);
    doc.users[0].should.have.property('userId', 'u1');
  });

  it('does not overwrite existing subdoc field values', function() {
    var schema = makeModelSchema(
      { users: [] },
      { users: { hideFrom: [], roles: [] } }
    );
    var doc = new FirestoreDocument(
      { _id: 'doc2', users: [{ userId: 'u2', hideFrom: ['dashboard'], roles: ['admin'] }] },
      fakeRef,
      schema
    );
    doc.users[0].hideFrom.should.deep.equal(['dashboard']);
    doc.users[0].roles.should.deep.equal(['admin']);
  });

  it('handles empty array — no errors', function() {
    var schema = makeModelSchema(
      { users: [] },
      { users: { hideFrom: [], roles: [] } }
    );
    var doc = new FirestoreDocument(
      { _id: 'doc3', users: [] },
      fakeRef,
      schema
    );
    doc.users.should.deep.equal([]);
  });

  it('handles missing array field — top-level default applied, subdoc applied to elements', function() {
    var schema = makeModelSchema(
      { users: [] },
      { users: { hideFrom: [], roles: [] } }
    );
    var doc = new FirestoreDocument(
      { _id: 'doc4' },  // no users field at all
      fakeRef,
      schema
    );
    doc.users.should.deep.equal([]);
  });

  it('handles multiple array elements', function() {
    var schema = makeModelSchema(
      { users: [] },
      { users: { hideFrom: [], roles: [] } }
    );
    var doc = new FirestoreDocument(
      { _id: 'doc5', users: [{ userId: 'u1' }, { userId: 'u2', hideFrom: ['all'] }, { userId: 'u3' }] },
      fakeRef,
      schema
    );
    doc.users[0].hideFrom.should.deep.equal([]);
    doc.users[0].roles.should.deep.equal([]);
    doc.users[1].hideFrom.should.deep.equal(['all']);
    doc.users[1].roles.should.deep.equal([]);
    doc.users[2].hideFrom.should.deep.equal([]);
    doc.users[2].roles.should.deep.equal([]);
  });

  it('does not treat undefined subdoc field value as present', function() {
    var schema = makeModelSchema(
      { users: [] },
      { users: { roles: [] } }
    );
    var doc = new FirestoreDocument(
      { _id: 'doc6', users: [{ userId: 'u1', roles: undefined }] },
      fakeRef,
      schema
    );
    doc.users[0].roles.should.deep.equal([]);
  });

  it('top-level defaults still work alongside subdoc defaults', function() {
    var schema = makeModelSchema(
      { name: 'untitled', users: [] },
      { users: { hideFrom: [] } }
    );
    var doc = new FirestoreDocument(
      { _id: 'doc7', users: [{ userId: 'u1' }] },
      fakeRef,
      schema
    );
    doc.name.should.equal('untitled');
    doc.users[0].hideFrom.should.deep.equal([]);
  });
});

// ---------------------------------------------------------------------------
// resolvePositionalUpdates
// ---------------------------------------------------------------------------

describe('resolvePositionalUpdates', function() {
  var users = [
    { userId: 'u1', roles: ['course-student'] },
    { userId: 'u2', roles: ['course-student'] }
  ];
  var doc = { users: users };

  it('replaces the matched element sub-field via positional path', function() {
    var filter = { _id: 'c1', users: { $elemMatch: { userId: 'u2' } } };
    var setFields = { 'users.$.roles': ['course-associate'] };
    var patch = resolvePositionalUpdates(setFields, filter, doc);
    patch.should.have.property('users');
    patch.users[0].roles.should.deep.equal(['course-student']);
    patch.users[1].roles.should.deep.equal(['course-associate']);
  });

  it('does not mutate the original array', function() {
    var filter = { _id: 'c1', users: { $elemMatch: { userId: 'u1' } } };
    var setFields = { 'users.$.roles': ['course-owner'] };
    var original = [{ userId: 'u1', roles: ['course-student'] }];
    var docCopy = { users: original };
    resolvePositionalUpdates(setFields, filter, docCopy);
    original[0].roles.should.deep.equal(['course-student']);
  });

  it('returns empty patch when no $elemMatch in filter', function() {
    var filter = { _id: 'c1' };
    var setFields = { 'users.$.roles': ['course-associate'] };
    var patch = resolvePositionalUpdates(setFields, filter, doc);
    patch.should.deep.equal({});
  });

  it('returns empty patch when no matching element found', function() {
    var filter = { _id: 'c1', users: { $elemMatch: { userId: 'u999' } } };
    var setFields = { 'users.$.roles': ['course-associate'] };
    var patch = resolvePositionalUpdates(setFields, filter, doc);
    patch.should.deep.equal({});
  });

  it('passes through non-positional fields unchanged', function() {
    var filter = { _id: 'c1', users: { $elemMatch: { userId: 'u1' } } };
    var setFields = { name: 'CS 101', 'users.$.roles': ['course-owner'] };
    var patch = resolvePositionalUpdates(setFields, filter, doc);
    patch.should.have.property('name', 'CS 101');
    patch.should.have.property('users');
  });

  it('handles multiple positional fields targeting the same array', function() {
    var filter = { _id: 'c1', users: { $elemMatch: { userId: 'u1' } } };
    var docTwo = { users: [{ userId: 'u1', roles: ['course-student'], displayName: 'Alice' }] };
    var setFields = { 'users.$.roles': ['course-owner'], 'users.$.displayName': 'Alice Admin' };
    var patch = resolvePositionalUpdates(setFields, filter, docTwo);
    patch.should.have.property('users');
    patch.users[0].roles.should.deep.equal(['course-owner']);
    patch.users[0].displayName.should.equal('Alice Admin');
  });
});

// ---------------------------------------------------------------------------
// resolvePositionalArrayOp
// ---------------------------------------------------------------------------

describe('resolvePositionalArrayOp', function() {
  function makeDoc(hideFrom) {
    return {
      users: [
        { userId: 'u1', hideFrom: hideFrom ? hideFrom.slice() : [] },
        { userId: 'u2', hideFrom: [] }
      ]
    };
  }

  it('$push: adds value to the matched element sub-array', function() {
    var filter = { _id: 'c1', users: { $elemMatch: { userId: 'u1' } } };
    var doc = makeDoc([]);
    var patch = resolvePositionalArrayOp({ 'users.$.hideFrom': 'dashboard' }, filter, doc, '$push');
    patch.should.have.property('users');
    patch.users[0].hideFrom.should.deep.equal(['dashboard']);
    patch.users[1].hideFrom.should.deep.equal([]);
  });

  it('$push: does not add duplicate value', function() {
    var filter = { _id: 'c1', users: { $elemMatch: { userId: 'u1' } } };
    var doc = makeDoc(['dashboard']);
    var patch = resolvePositionalArrayOp({ 'users.$.hideFrom': 'dashboard' }, filter, doc, '$push');
    patch.users[0].hideFrom.should.deep.equal(['dashboard']);
  });

  it('$pull: removes value from the matched element sub-array', function() {
    var filter = { _id: 'c1', users: { $elemMatch: { userId: 'u1' } } };
    var doc = makeDoc(['dashboard', 'all']);
    var patch = resolvePositionalArrayOp({ 'users.$.hideFrom': 'dashboard' }, filter, doc, '$pull');
    patch.users[0].hideFrom.should.deep.equal(['all']);
  });

  it('$pull: is a no-op when value not present', function() {
    var filter = { _id: 'c1', users: { $elemMatch: { userId: 'u1' } } };
    var doc = makeDoc(['all']);
    var patch = resolvePositionalArrayOp({ 'users.$.hideFrom': 'dashboard' }, filter, doc, '$pull');
    patch.users[0].hideFrom.should.deep.equal(['all']);
  });

  it('returns empty patch when no matching element found', function() {
    var filter = { _id: 'c1', users: { $elemMatch: { userId: 'u999' } } };
    var doc = makeDoc([]);
    var patch = resolvePositionalArrayOp({ 'users.$.hideFrom': 'dashboard' }, filter, doc, '$push');
    patch.should.deep.equal({});
  });

  it('does not mutate the original doc array', function() {
    var filter = { _id: 'c1', users: { $elemMatch: { userId: 'u1' } } };
    var original = [{ userId: 'u1', hideFrom: ['dashboard'] }];
    var doc = { users: original };
    resolvePositionalArrayOp({ 'users.$.hideFrom': 'all' }, filter, doc, '$push');
    original[0].hideFrom.should.deep.equal(['dashboard']);
  });
});

// ---------------------------------------------------------------------------
// Course-shaped schema — integration smoke test
// ---------------------------------------------------------------------------

describe('FirestoreDocument course-shaped schema', function() {
  var courseSubdocSchema = {
    paths: {
      name:        { instance: 'String',  defaultValue: '' },
      description: { instance: 'String',  defaultValue: '' },
      users: {
        $isMongooseArray: true,
        schema: {
          paths: {
            userId:   { instance: 'ObjectID', defaultValue: undefined },
            hideFrom: { instance: 'Array', $isMongooseArray: true },
            roles:    { instance: 'Array', $isMongooseArray: true }
          }
        }
      }
    }
  };

  it('extracts the right top-level defaults', function() {
    var defs = extractDefaults(courseSubdocSchema);
    defs.should.have.property('name', '');
    defs.should.have.property('description', '');
    defs.should.have.property('users').that.deep.equals([]);
  });

  it('extracts subdoc defaults for the users array', function() {
    var subdocDefs = extractSubdocDefaults(courseSubdocSchema);
    subdocDefs.should.deep.equal({ users: { hideFrom: [], roles: [] } });
  });

  it('applies subdoc defaults when constructing a document from Firestore data', function() {
    var modelSchema = makeModelSchema(
      extractDefaults(courseSubdocSchema),
      extractSubdocDefaults(courseSubdocSchema)
    );
    var firestoreData = {
      _id:         'course1',
      name:        'CS 101',
      description: 'Intro course',
      users: [
        { userId: 'teacher1' },          // no hideFrom, no roles
        { userId: 'student1', roles: ['course-student'] }  // no hideFrom
      ]
    };
    var doc = new FirestoreDocument(firestoreData, fakeRef, modelSchema);

    doc.users[0].hideFrom.should.deep.equal([]);
    doc.users[0].roles.should.deep.equal([]);
    doc.users[1].hideFrom.should.deep.equal([]);
    doc.users[1].roles.should.deep.equal(['course-student']);
  });
});
