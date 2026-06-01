var FileUtil = require('../util/file'),
    Hapi     = require('@hapi/hapi'),
    errors   = require('@hapi/boom'),
    fs       = require('fs'),
    config   = require('config'),
    mime     = require('mime'),
    sluggify = require('limax');

module.exports = {
  uploadAvatar : function(request, reply) {
    if (!config.features.assets) {
      return reply(errors.notImplemented('Avatar uploads are not enabled'));
    }
    FileUtil.uploadUserAvatar(request.payload.upload, function(err, results) {
      if (err) {
        return reply(err);
      }

      request.success(results);
    });
  },

  upload : function(request, reply) {
    if (!config.features.assets) {
      return reply(errors.notImplemented('File uploads are not enabled'));
    }
    FileUtil.uploadMaterialFile(request.payload.upload, function(err, results) {
      err && console.log(err);

      // eventually allow upload of a markdown file?

      var contentType = request.payload.upload.headers['content-type'];
      var type = request.payload.type;
      if (typeof type == 'undefined') {
        type = /^image/.test(contentType)
          ? 'embed'
          : 'download';
      }

      var fileName = request.payload.upload.filename;
      var fileExt  = fileName.lastIndexOf('.') > -1 ? fileName.substring(fileName.lastIndexOf('.') + 1, fileName.length) : '';
      var ext      = config.app.extensionWhitelist[fileExt] ? fileExt : mime.extension(contentType);
      var fileMime = config.app.extensionWhitelist[fileExt] ? config.app.extensionWhitelist[fileExt] : contentType;

      var file = new File({
        url  : results.host + '/' + results.path,
        type : type,
        name : fileName,
        mime : fileMime,
        hash : results.hash,
        size : results.size
      });

      file.setOwner(request.user);

      // check existing file with same hash, name and owner?

      file.save(function(err) {
        err &&  console.log(err);

        var sansExt = file.name.substring(0, file.name.lastIndexOf('.'));
        var path    = '/api/files/' + file.id + '/' + sluggify(sansExt, {maintainCase:true});
        if (ext) {
          path += '.' + ext;
        }

        request.success({
          id   : file.id,
          path : path,
          type : file.type,
          mime : file.mime,
          host : config.app.url.hostname,
          name : file.name,
          size : file.size,
        });
      });
    });
  },
  download : function(request, reply) {
    var remoteUrl  = request.pre.file.url;
    var fileIndex  = remoteUrl.lastIndexOf('/');
    var remoteFile = remoteUrl.substring(fileIndex + 1, remoteUrl.length);

    var debug = config.app.log.debug,
        start, end, seconds;

    if (debug && debug.files) start = process.hrtime();

    var stream     = FileUtil.downloadMaterialFile(remoteFile);

    if (debug && debug.files) {
      end = process.hrtime(start);
      seconds = end[0] + end[1] * 1e-9;
      log.debug("file download debug", { raw_diff : end, seconds : seconds, fileId : request.pre.file.id, fileUrl : request.pre.file.url });
    }

    if (/^image/.test(request.pre.file.mime)) {
      reply(stream)
        .type(request.pre.file.mime)
        .bytes(request.pre.file.size);
    } else {
      reply(stream)
        .type(request.pre.file.mime)
        .bytes(request.pre.file.size)
        .header('Content-Disposition', 'attachment; filename=' + request.pre.file.name);
    }
  },
  setThumbnail : function(request, reply) {
    if (request.payload.secret !== config.aws.lambda.createThumbnail.secret) {
      return request.fail();
    }

    var bucket   = request.payload.bucket;

    var fileName = request.pre.file.name;
    var fileExt  = fileName.lastIndexOf('.') > -1 ? fileName.substring(fileName.lastIndexOf('.') + 1, fileName.length) : '';

    var thumb = config.aws.buckets[bucket].thumbnail.replace('%{s}', request.pre.file.hash);
    thumb    += '-' + request.pre.file.id;

    request.pre.file.thumb = config.aws.buckets[bucket].thumbnailHost + '/' + thumb + '.' + fileExt;

    request.pre.file.save(function(err, file) {
      return request.success();
    });
  }
};
