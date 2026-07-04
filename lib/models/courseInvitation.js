var mongoose  = require('mongoose')
  , model     = require('./model')
  , _         = require('underscore')
  , validator = require('validator')
  , crypto    = require('crypto')
  , config    = require('config')
  , nunjucks  = require('../util/nunjucks')
  , mailer    = require('../util/mailer')
  , schema   = {
        courseId : { type : mongoose.SchemaTypes.ObjectId, ref : 'Course' }
      , email    : { type : String, required: true }
      , name     : { type : String }
      , sentOn   : { type : Date }
      , token    : { type : String, required: true, index: true }
      , status   : { type : String, required: true, default: 'pending' } // pending, sent, invalid, resend, accepted
    };

var url = config.app.url.protocol + '://' + config.app.url.hostname;

function addList(students, course) {
  var self = this
    , currentEmails
    , token, query, update, updateOptions;

  // Accept plain email strings or {email, name} objects
  students = students.map(function(s) {
    return typeof s === 'string' ? { email: s.toLowerCase(), name: '' } : { email: s.email.toLowerCase(), name: s.name || '' };
  });

  currentEmails = course.users.map(function(user) {
    return user.email.toLowerCase();
  });

  // Deduplicate by email, keeping last-seen name
  var seen = {};
  students.forEach(function(s) { seen[s.email] = s.name; });
  students = Object.keys(seen)
    .filter(function(email) { return currentEmails.indexOf(email) === -1; })
    .map(function(email) { return { email: email, name: seen[email] }; });

  return Promise.all(students.map(function(student) {
    token = crypto.createHash("md5").update(student.email + course.id).digest("hex").substring(0, 8);

    query = {
        courseId : course.id
      , email    : student.email
    };

    update = {
        courseId    : course.id
      , email       : student.email
      , name        : student.name
      , token       : token
      , status      : "pending"
      , lastUpdated : Date.now()
    };

    if (!validator.isEmail(student.email)) {
      update.status = "invalid";
    }

    updateOptions = {
        new    : true
      , upsert : true
    };

    return self.model.findOneAndUpdate(query, update, updateOptions).exec();
  }));
}

function sendInvitationEmail(invitation, course, user) {
  if (invitation.status !== "pending" && invitation.status !== "resend") {
    return Promise.resolve();
  }

  var acceptUrl = url + "/courses/accept/" + invitation.token;
  var subject   = "Trinket Invitation to " + course.name;

  var emailTemplateData = {
      inviterName       : user.fullname
    , courseName        : course.name
    , courseDescription : course.description
    , acceptUrl         : acceptUrl
  };

  return nunjucks.render("emails/course-invitation", emailTemplateData)
    .then(function(emailMessage) {
      return mailer.send(invitation.email, subject, { html : emailMessage, replyTo : user.email, type : 'course-invitation' });
    })
    .then(function() {
      invitation.status = "sent";
      invitation.sentOn = Date.now();
      return invitation.save();
    })
    .catch(function(err) {
      console.error('Failed to send course invitation email:', err.message);
      // Don't fail the whole operation if email fails
      return Promise.resolve();
    });
}

function sendEmails(invitations, course, user) {
  return Promise.all(invitations.map(function(invitation) {
    return sendInvitationEmail(invitation, course, user);
  }));
}

function findUnacceptedByCourse(course) {
  var query = {
      courseId : course.id
    , status   : { "$ne" : "accepted" }
  };

  return this.model.find(query).exec();
}

function findByToken(token) {
  return this.model.findOne({ token : token }).exec();
}

function updateEmail(email) {
  this.email  = email.toLowerCase();
  this.status = validator.isEmail(this.email) ? "resend" : "invalid";
}

var CourseInvitation = model.create("CourseInvitation", {
    schema       : schema
  , classMethods : {
        addList                : addList
      , sendEmails             : sendEmails
      , findUnacceptedByCourse : findUnacceptedByCourse
      , findByToken            : findByToken
    }
  , objectMethods : {
        updateEmail : updateEmail
    }
  , index: [
      [{ courseId : 1, email : 1 }, { unique : true }]
    ]
  , publicSpec   : {
        id     : true
      , email  : true
      , name   : true
      , sent   : true
      , token  : true
      , status : true
    }
});

module.exports = CourseInvitation.publicModel;
