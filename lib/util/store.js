var config = require('config');
var _ = require('underscore');

// Check if Redis is enabled
var redisEnabled = config.db && config.db.redis && config.db.redis.enabled !== false;

// Use Firestore-backed list client for slug stores when Firestore is the db backend
var firestoreBackend = config.db && config.db.backend === 'firestore';

// In-memory cache implementation
var memoryCache = {};
var memorySets = {};
var memoryLists = {};

var InMemoryClient = {
  get: async function(key) {
    return memoryCache[key] || null;
  },
  set: async function(key, value) {
    memoryCache[key] = value;
    return 'OK';
  },
  del: async function(key) {
    delete memoryCache[key];
    return 1;
  },
  expire: async function(key, seconds) {
    // Simple expiration - delete after timeout
    setTimeout(function() {
      delete memoryCache[key];
    }, seconds * 1000);
    return 1;
  },
  incr: async function(key) {
    var val = parseInt(memoryCache[key] || '0', 10);
    memoryCache[key] = String(val + 1);
    return val + 1;
  },
  // Set operations
  sIsMember: async function(setKey, member) {
    var set = memorySets[setKey] || [];
    return set.indexOf(member) >= 0;
  },
  sAdd: async function(setKey, members) {
    if (!memorySets[setKey]) {
      memorySets[setKey] = [];
    }
    var arr = Array.isArray(members) ? members : [members];
    var added = 0;
    arr.forEach(function(member) {
      if (memorySets[setKey].indexOf(member) < 0) {
        memorySets[setKey].push(member);
        added++;
      }
    });
    return added;
  },
  sRem: async function(setKey, member) {
    if (!memorySets[setKey]) return 0;
    var idx = memorySets[setKey].indexOf(member);
    if (idx >= 0) {
      memorySets[setKey].splice(idx, 1);
      return 1;
    }
    return 0;
  },
  // List operations
  lIndex: async function(listKey, index) {
    var list = memoryLists[listKey] || [];
    return list[index] || null;
  },
  lPush: async function(listKey, value) {
    if (!memoryLists[listKey]) {
      memoryLists[listKey] = [];
    }
    memoryLists[listKey].unshift(value);
    return memoryLists[listKey].length;
  },
  lRem: async function(listKey, count, value) {
    if (!memoryLists[listKey]) return 0;
    var removed = 0;
    memoryLists[listKey] = memoryLists[listKey].filter(function(item) {
      if (item === value && (count === 0 || removed < Math.abs(count))) {
        removed++;
        return false;
      }
      return true;
    });
    return removed;
  },
  // Additional list operations
  lRange: async function(listKey, start, stop) {
    var list = memoryLists[listKey] || [];
    if (stop === -1) stop = list.length - 1;
    return list.slice(start, stop + 1);
  },
  rPush: async function(listKey, value) {
    if (!memoryLists[listKey]) {
      memoryLists[listKey] = [];
    }
    memoryLists[listKey].push(value);
    return memoryLists[listKey].length;
  },
  // Key operations
  exists: async function(key) {
    return memoryCache.hasOwnProperty(key) || memorySets.hasOwnProperty(key) || memoryLists.hasOwnProperty(key) ? 1 : 0;
  },
  keys: async function(pattern) {
    var allKeys = Object.keys(memoryCache).concat(Object.keys(memorySets)).concat(Object.keys(memoryLists));
    if (pattern === '*') return allKeys;
    var regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return allKeys.filter(function(key) {
      return regex.test(key);
    });
  },
  // Set members
  sMembers: async function(setKey) {
    return memorySets[setKey] || [];
  },
  // Hash operations (if needed)
  hGet: async function(hashKey, field) {
    var hash = memoryCache[hashKey];
    if (!hash || typeof hash !== 'object') return null;
    return hash[field] || null;
  },
  hSet: async function(hashKey, field, value) {
    if (!memoryCache[hashKey] || typeof memoryCache[hashKey] !== 'object') {
      memoryCache[hashKey] = {};
    }
    memoryCache[hashKey][field] = value;
    return 1;
  },
  hGetAll: async function(hashKey) {
    return memoryCache[hashKey] || null;
  }
};

// Redis client (lazy loaded)
var redisClient = null;
var redisClientPromise = null;

async function getRedisClient() {
  if (!redisEnabled) {
    return InMemoryClient;
  }

  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }

  if (redisClientPromise) {
    return redisClientPromise;
  }

  redisClientPromise = (async function() {
    var redis = require('redis');
    var redisConfig = config.db.redis.app;

    var options = {
      socket: {
        host: redisConfig.host,
        port: redisConfig.port
      }
    };

    if (redisConfig.pass) {
      options.password = redisConfig.pass;
    }

    redisClient = redis.createClient(options);

    redisClient.on('error', function(err) {
      console.log('Redis client error:', err.message);
    });

    await redisClient.connect();
    console.log('Redis client connected to', redisConfig.host + ':' + redisConfig.port);
    return redisClient;
  })();

  return redisClientPromise;
}

// Firestore-backed list client for slug stores (userStore, courseStore, trinketStore)
var firestoreListClient = null;

async function getStoreClient() {
  if (firestoreBackend) {
    if (!firestoreListClient) {
      firestoreListClient = require('./store/firestore-client');
    }
    return firestoreListClient;
  }
  return getRedisClient();
}

// Store implementations
var TrinketStore = require('./store/trinketStore');
var CourseStore = require('./store/courseStore');
var FeaturedStore = require('./store/featuredStore');
var EmailStore = require('./store/emailStore');
var UserStore = require('./store/userStore');

var trinketInterface;
var courseInterface;
var featuredInterface;
var emailInterface;
var userInterface;

function Store() {}

_.extend(Store.prototype, {
  // Base client: used for get/set/del/expire (temp tokens, rate-limit keys).
  // Falls back to InMemoryClient when Redis is disabled.
  _getClient: getRedisClient,

  // Slug-store client: uses Firestore when db.backend is 'firestore',
  // otherwise falls back to the same Redis/in-memory client.
  _getStoreClient: getStoreClient,

  get: async function(key) {
    var client = await this._getClient();
    return await client.get(key);
  },
  set: async function(key, val) {
    var client = await this._getClient();
    return await client.set(key, val);
  },
  del: async function(key) {
    var client = await this._getClient();
    return await client.del(key);
  },
  expire: async function(key, s) {
    var client = await this._getClient();
    return await client.expire(key, s);
  },
  trinkets: function() {
    if (!trinketInterface) {
      trinketInterface = TrinketStore(this._getStoreClient);
    }
    return trinketInterface;
  },
  courses: function() {
    if (!courseInterface) {
      courseInterface = CourseStore(this._getStoreClient);
    }
    return courseInterface;
  },
  featured: function() {
    if (!featuredInterface) {
      featuredInterface = FeaturedStore();
    }
    return featuredInterface;
  },
  email: function() {
    if (!emailInterface) {
      emailInterface = EmailStore(this._getClient);
    }
    return emailInterface;
  },
  user: {
    reset_password_key: function(key) {
      return ['user', key, 'reset'].join(':');
    },
    change_email_key: function(key) {
      return ['user', key, 'email'].join(':');
    },
    verify_email_key: function(key) {
      return ['user', key, 'verifyemail'].join(':');
    },
    activate_account_key: function(key) {
      return ['user', key, 'activate'].join(':');
    }
  },
  users: function() {
    if (!userInterface) {
      userInterface = UserStore(this._getStoreClient);
    }
    return userInterface;
  }
});

// Export singleton
var store = new Store();

// Export utilities
store.isRedisEnabled = function() {
  return redisEnabled;
};

store.getClient = getRedisClient;

module.exports = store;
