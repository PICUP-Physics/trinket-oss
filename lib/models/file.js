var model   = require('./model'),
    ownable = require('./plugins/ownable'),
    schema  = {
      hash    : { type: String },
      url     : { type: String },
      type    : { type: String, enum: ['embed', 'download'], default: 'download' },
      name    : { type: String },
      mime    : { type: String },
      size    : { type: Number },
      thumb   : { type: String },
      hidden  : { type: Boolean, default : false },
      metrics : {
        trinkets : { type: Number, default: 0 }
      }
    };

function hide() {
  this.hidden = true;
  return this.save();
}

function show() {
  this.hidden = false;
  return this.save();
}

function findByIdAndUpdateMetric(fileId, metric, amount) {
  var update = {
    $inc : {}
  };

  update.$inc['metrics.' + metric] = amount;

  var options = { new : true, upsert : true };

  return this.model.findByIdAndUpdate(fileId, update, options).exec();
}

module.exports = model.create('File', {
  schema       : schema,
  alternateIds : ['hash'],
  plugins      : [ ownable ],
  classMethods : {
    findForUser             : true,
    findByIdAndUpdateMetric : findByIdAndUpdateMetric
  },
  objectMethods : {
    hide : hide,
    show : show
  },
  publicSpec   : {
    id          : true,
    url         : true,
    name        : true,
    mime        : true,
    size        : true,
    thumb       : true,
    isDemo      : true,
    lastUpdated : true,
    hidden      : true,
    metrics     : true
  }
}).publicModel;
