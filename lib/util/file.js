var PassThrough     = require('stream').PassThrough,
    crypto          = require('crypto'),
    config          = require('config'),
    aws             = require('../../config/aws'),
    File            = require('../models/file'),
    fs              = require('fs');

var _gcsStorage;
function getGCSStorage() {
  if (!_gcsStorage) {
    var Storage = require('@google-cloud/storage').Storage;
    var projectId = (config.db.firestore && config.db.firestore.projectId) || process.env.GOOGLE_CLOUD_PROJECT;
    _gcsStorage = new Storage(projectId ? { projectId: projectId } : {});
  }
  return _gcsStorage;
}

function useGCS() {
  return config.storage && config.storage.backend === 'gcs';
}

function FileUtil() {
  var self = this;

  this._upload = function(stream, container, s3, fileinfo, cb) {
    if (useGCS()) {
      var writeStream = getGCSStorage()
        .bucket(container.name)
        .file(fileinfo.name)
        .createWriteStream({ metadata: { contentType: fileinfo.contentType }, resumable: false });
      writeStream.on('error', cb);
      writeStream.on('finish', function() { cb(null, {}); });
      if (Buffer.isBuffer(stream)) {
        var pass = new PassThrough();
        pass.end(stream);
        pass.pipe(writeStream);
      } else {
        stream.pipe(writeStream);
      }
    } else {
      var client = new aws.S3();
      client.putObject({
        Bucket      : container.name,
        Key         : fileinfo.name,
        Body        : stream,
        ContentType : fileinfo.contentType
      }, function(err, data) {
        cb(err, data);
      });
    }
  };

  this._fileToContainer = function(upload, container, s3, cb) {
    var contentType = upload.headers['content-type'];

    var filename  = upload.filename;
    var extension = filename.lastIndexOf('.') > -1 ? filename.substring(filename.lastIndexOf('.') + 1, filename.length) : '';

    if (config.app.extensionWhitelist[extension]) {
      contentType = config.app.extensionWhitelist[extension];
    }

    self.hashcontents(upload.path, function(digest) {
      var fileinfo = {
        name        : digest,
        contentType : contentType
      };

      if (container.fileId) {
        fileinfo.name += '-' + container.fileId;
      }
      if (extension) {
        fileinfo.name += '.' + extension;
      }

      var uploadStream = fs.createReadStream(upload.path);

      self._upload(uploadStream, container, s3, fileinfo, function(err) {
        err && console.log(err);

        fs.unlink(upload.path, function(err) {
          cb(err, {
            host : container.host,
            path : fileinfo.name,
            name : fileinfo.name,
            hash : digest,
            size : upload.bytes
          });
        });
      });
    });
  };

  this.hashcontents = function(path, cb) {
    var stream = fs.createReadStream(path);
    var hash   = crypto.createHash('sha1');

    hash.setEncoding('hex');

    stream.on('end', function() {
      hash.end();
      cb(hash.read());
    });

    stream.pipe(hash);
  };

  this.downloadMaterialFile = function(remote) {
    var stream = new PassThrough;
    if (useGCS()) {
      getGCSStorage()
        .bucket(config.aws.buckets.materials.name)
        .file(remote)
        .createReadStream()
        .pipe(stream);
    } else {
      var client = new aws.S3();
      client.getObject({
        Bucket : config.aws.buckets.materials.name,
        Key    : remote
      }).createReadStream().pipe(stream);
    }
    return stream;
  };

  this.downloadMaterialFileAsBuffer = function(remote) {
    if (useGCS()) {
      return getGCSStorage()
        .bucket(config.aws.buckets.materials.name)
        .file(remote)
        .download()
        .then(function(data) { return data[0]; });
    }
    var client = new aws.S3();
    return new Promise(function(resolve, reject) {
      client.getObject({ Bucket: config.aws.buckets.materials.name, Key: remote },
        function(err, data) { if (err) reject(err); else resolve(data.Body); });
    });
  };

  this.uploadMaterialFile = function(upload, cb) {
    var container = config.aws.buckets.materials;
    self._fileToContainer(upload, container, true, cb);
  };

  this.uploadUserAvatar = function(upload, cb) {
    if (!/^image\/(png|jpg|jpeg)$/.test(upload.headers['content-type'])) {
      return cb(new Error('unsupported image type, must be png or jpg'));
    }
    var container = config.aws.buckets.useravatars;
    self._fileToContainer(upload, container, true, cb);
  };

  // can be removed once uploadSnapshotFromBuffer has been tested in prod
  this.uploadSnapshot = function(file, cb) {
    setTimeout(function() {
      fs.exists(file.path + file.name, function(snapshotExists) {
        if (snapshotExists) {
          var uploadStream = fs.createReadStream(file.path + file.name);
          var fileinfo = {
            name        : file.name,
            contentType : 'image/png'
          };
          self._upload(uploadStream, config.aws.buckets.snapshots, true, fileinfo, cb);
        }
        else {
          cb(new Error("Snapshot does not exists: " + file.path + file.name));
        }
      });
    }, 1000);
  };

  this.uploadSnapshotFromBuffer = function(filename, filedata, cb) {
    var fileinfo = {
      name: filename,
      contentType: 'image/png'
    };
    self._upload(filedata, config.aws.buckets.snapshots, true, fileinfo, cb);
  };

  this.removeFile = function(container, file, cb) {
    if (typeof cb !== 'function') {
      cb = function(err, result) { return result; };
    }

    var filename = file.substring(file.lastIndexOf('/') + 1, file.length);

    if (useGCS()) {
      getGCSStorage()
        .bucket(config.aws.buckets[container].name)
        .file(filename)
        .delete(cb);
    } else {
      var client = new aws.S3();
      client.deleteObject({
        Bucket : config.aws.buckets[container].name,
        Key    : filename
      }, cb);
    }
  };

  this.uploadUserAsset = function(fileupload, user, replaceFile, cb) {
    var contentType = fileupload.headers['content-type'];
    var filename    = fileupload.filename;
    var extension   = filename.lastIndexOf('.') > -1 ? filename.substring(filename.lastIndexOf('.') + 1, filename.length) : '';

    if (typeof replaceFile === 'function') {
      cb = replaceFile;
      replaceFile = null;
    }

    self.hashcontents(fileupload.path, function(digest) {
      var container = config.aws.buckets.userassets
        , remoteName, file;

      if (replaceFile != null) {
        file = replaceFile;
      }
      else {
        file = new File();
      }

      file.name = filename;
      file.type = 'embed';
      file.mime = contentType;
      file.hash = digest;
      file.size = fileupload.bytes;

      file.setOwner(user);

      remoteName = digest + '-' + file.id + '.' + extension;
      file.url   = container.host + '/' + remoteName;

      file.save(function(err) {
        if (err) return cb(err);

        var uploadStream = fs.createReadStream(fileupload.path);
        var fileinfo = {
          name        : remoteName,
          contentType : contentType
        };
        self._upload(uploadStream, container, true, fileinfo, function(err, results) {
          cb(err, file);
        });
      });
    });
  };

  this.downloadUserAsset = function(remote) {
    return new Promise(function(resolve, reject) {
      if (useGCS()) {
        var chunks = [];
        getGCSStorage()
          .bucket(config.aws.buckets.userassets.name)
          .file(remote)
          .createReadStream()
          .on('error', reject)
          .on('data', function(chunk) { chunks.push(chunk); })
          .on('end', function() { resolve(Buffer.concat(chunks)); });
      } else {
        var client = new aws.S3();
        client.getObject({
          Bucket : config.aws.buckets.userassets.name,
          Key    : remote
        }, function(err, data) {
          if (err) return reject(err);
          return resolve(data.Body);
        });
      }
    });
  };

  // TODO: implement as needed
  this.uploadOrgImage = function(stream, cb) {
    cb(null);
  };
}

module.exports = new FileUtil();
