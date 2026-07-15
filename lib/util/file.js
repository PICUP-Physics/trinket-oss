var PassThrough = require('stream').PassThrough,
    crypto      = require('crypto'),
    config      = require('config'),
    File        = require('../models/file'),
    fs          = require('fs'),
    backend     = require('./storage-backend');

function FileUtil() {
  var self = this;

  this._upload = function(stream, container, s3, fileinfo, cb) {
    backend.upload(container.name, fileinfo.name, stream, fileinfo.contentType, cb);
  };

  this._fileToContainer = function(upload, container, s3, cb) {
    var contentType = upload.headers['content-type'];
    var filename    = upload.filename;
    var extension   = filename.lastIndexOf('.') > -1
      ? filename.substring(filename.lastIndexOf('.') + 1)
      : '';

    if (config.app.extensionWhitelist[extension]) {
      contentType = config.app.extensionWhitelist[extension];
    }

    self.hashcontents(upload.path, function(digest) {
      var fileinfo = { name: digest, contentType: contentType };
      if (container.fileId) fileinfo.name += '-' + container.fileId;
      if (extension)        fileinfo.name += '.' + extension;

      var uploadStream = fs.createReadStream(upload.path);
      self._upload(uploadStream, container, s3, fileinfo, function(uploadErr) {
        uploadErr && console.log(uploadErr);
        fs.unlink(upload.path, function(err) {
          // Propagate the STORAGE error — swallowing it here made the
          // controller reply 200 with a URL to an object that was never
          // stored (a dead file link).
          cb(uploadErr || err, {
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
    stream.on('end', function() { hash.end(); cb(hash.read()); });
    stream.pipe(hash);
  };

  this.downloadMaterialFile = function(remote) {
    var stream = new PassThrough();
    // pipe() does not forward 'error', and an unlistened 'error' event kills
    // the process — a missing object or storage blip must fail the request,
    // not the server.
    backend.downloadStream(config.aws.buckets.materials.name, remote)
      .on('error', function(err) { stream.destroy(err); })
      .pipe(stream);
    return stream;
  };

  this.downloadMaterialFileAsBuffer = function(remote) {
    return backend.downloadBuffer(config.aws.buckets.materials.name, remote);
  };

  this.uploadMaterialFile = function(upload, cb) {
    self._fileToContainer(upload, config.aws.buckets.materials, true, cb);
  };

  this.uploadUserAvatar = function(upload, cb) {
    if (!/^image\/(png|jpg|jpeg)$/.test(upload.headers['content-type'])) {
      return cb(new Error('unsupported image type, must be png or jpg'));
    }
    self._fileToContainer(upload, config.aws.buckets.useravatars, true, cb);
  };

  // can be removed once uploadSnapshotFromBuffer has been tested in prod
  this.uploadSnapshot = function(file, cb) {
    setTimeout(function() {
      fs.exists(file.path + file.name, function(snapshotExists) {
        if (snapshotExists) {
          var uploadStream = fs.createReadStream(file.path + file.name);
          self._upload(uploadStream, config.aws.buckets.snapshots, true,
            { name: file.name, contentType: 'image/png' }, cb);
        } else {
          cb(new Error('Snapshot does not exists: ' + file.path + file.name));
        }
      });
    }, 1000);
  };

  this.uploadSnapshotFromBuffer = function(filename, filedata, cb) {
    self._upload(filedata, config.aws.buckets.snapshots, true,
      { name: filename, contentType: 'image/png' }, cb);
  };

  this.removeFile = function(container, file, cb) {
    if (typeof cb !== 'function') cb = function(err, result) { return result; };
    var filename = file.substring(file.lastIndexOf('/') + 1);
    backend.deleteFile(config.aws.buckets[container].name, filename, cb);
  };

  this.uploadUserAsset = function(fileupload, user, replaceFile, cb) {
    var contentType = fileupload.headers['content-type'];
    var filename    = fileupload.filename;
    var extension   = filename.lastIndexOf('.') > -1
      ? filename.substring(filename.lastIndexOf('.') + 1)
      : '';

    if (typeof replaceFile === 'function') { cb = replaceFile; replaceFile = null; }

    self.hashcontents(fileupload.path, function(digest) {
      var container  = config.aws.buckets.userassets;
      var file       = replaceFile != null ? replaceFile : new File();

      file.name = filename;
      file.type = 'embed';
      file.mime = contentType;
      file.hash = digest;
      file.size = fileupload.bytes;
      file.setOwner(user);

      var remoteName = digest + '-' + file.id + '.' + extension;
      file.url = container.host + '/' + remoteName;

      file.save(function(err) {
        if (err) return cb(err);
        var uploadStream = fs.createReadStream(fileupload.path);
        self._upload(uploadStream, container, true,
          { name: remoteName, contentType: contentType },
          function(err) { cb(err, file); });
      });
    });
  };

  this.downloadUserAsset = function(remote) {
    return backend.downloadBuffer(config.aws.buckets.userassets.name, remote);
  };

  // TODO: implement as needed
  this.uploadOrgImage = function(stream, cb) { cb(null); };
}

module.exports = new FileUtil();
