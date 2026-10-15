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

  // Skip members with no email rather than throwing on them. email is optional
  // on the embedded member (models/course.js) and addUser copies it verbatim, so
  // a member without one is a shape the data genuinely takes. Mapping blindly
  // threw a TypeError here, which reply(err) turned into a bare 500 — Add
  // Students then failed for the WHOLE course, for every instructor, with
  // nothing in the app log to say why.
  //
  // Skipping is also the correct answer, not just the safe one: a member with no
  // email cannot match any invited address, so leaving them out of the dedupe
  // set changes no outcome for members that do have one.
  currentEmails = course.users.reduce(function(acc, user) {
    if (user && user.email) { acc.push(user.email.toLowerCase()); }
    return acc;
  }, []);

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
      return mailer.send(invitation.email, subject, { html : emailMessage, replyTo : user.email, type : 'course-invitation' })
        .catch(function(err) {
          // log with the MAIL_SEND_FAILED marker, then rethrow so the catch below still decides the outcome
          mailer.logFailure(err, { to : invitation.email, type : 'course-invitation' });
          throw err;
        });
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
  // Query by courseId (equality) and filter status in app code, rather than
  // status:{$ne:'accepted'}. On Firestore a `!=` combined with the `courseId ==`
  // equality needs a composite index (not deployed) and the query fails — the
  // instructor's pending-students list then comes back empty on reload
  // (MIAuthors #11). Equality-only is index-free and works on both backends.
  return this.model.find({ courseId : course.id }).exec()
    .then(function(invitations) {
      return invitations.filter(function(invitation) {
        return invitation.status !== "accepted";
      });
    });
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
