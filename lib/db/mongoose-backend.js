var mongoose = require('mongoose');

// Pass-through: registers the schema with Mongoose and returns the raw model.
// Class methods bound to {model: <this>} get the full Mongoose API unchanged.
function createModel(modelName, schema) {
  return mongoose.model(modelName, schema);
}

module.exports = { createModel: createModel };
