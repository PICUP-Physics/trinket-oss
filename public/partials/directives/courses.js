(function(angular) {
  'use strict';

  var myCourses = angular.module('trinket.myCourses', [
    'restangular',
    'trinket.roles'
  ]).config(['RestangularProvider', function(RestangularProvider) {
    RestangularProvider.setBaseUrl('/api');
    RestangularProvider.addResponseInterceptor(function(response) {
      return response.data ? response.data : response;
    });
    RestangularProvider.setDefaultHeaders({'Content-Type': 'application/json'});
  }]);


  myCourses.controller('CoursesController', ['$scope', '$http', '$window', '$document', 'trinketRoles', 'Restangular', function($scope, $http, $window, $document, roles, Restangular) {
    var courseRoles, courseUrl;

    $scope.coursesById = {};

    $scope.canCreateCourse = roles.hasPermission("create-public-course") ? true : false;
    $scope.courses;
    $scope.archived;
    $scope.showArchived = false;

    $scope.trinketTeacher = roles.hasRole("trinket-teacher");
    $scope.trinketAdmin   = roles.hasRole("admin");

    $scope.accessCode = "";
    $scope.checkingAccessCode = false;

    $scope.sortBy = 'name';
    $scope.sortOptions = {
      name        : { label: 'Name (A-Z)',      field: 'name',        reverse: false, class: 'fa fa-sort-alpha-asc' },
      nameDesc    : { label: 'Name (Z-A)',       field: 'name',        reverse: true,  class: 'fa fa-sort-alpha-desc' },
      lastUpdated : { label: 'Recently Updated', field: 'lastUpdated', reverse: true,  class: 'fa fa-clock-o' },
      lastViewed  : { label: 'Last Viewed',      field: 'lastViewed',  reverse: true,  class: 'fa fa-eye' },
      role        : { label: 'Your Role',        field: 'role',        reverse: false, class: 'fa fa-user' }
    };
    $scope.initSort = function(key) {
      $scope.sortBy = key;
    };
    $scope.courseSortValue = function(course) {
      switch ($scope.sortBy) {
        case 'name':
        case 'nameDesc':
          return (course.name || '').toLowerCase();
        case 'lastUpdated':
          return course.lastUpdated ? new Date(course.lastUpdated).getTime() : 0;
        case 'lastViewed':
          return course.lastViewed ? new Date(course.lastViewed).getTime() : 0;
        case 'role':
          return (course.role || '').toLowerCase();
      }
    };

    $scope.courseSearch = '';
    $scope.courseMatchesSearch = function(course) {
      var q = ($scope.courseSearch || '').toLowerCase();
      if (!q) { return true; }
      return (course.name || '').toLowerCase().indexOf(q) >= 0
          || (course.description || '').toLowerCase().indexOf(q) >= 0;
    };

    $scope.courseSearchOpen = false;
    $scope.toggleCourseSearch = function() {
      $scope.courseSearchOpen = !$scope.courseSearchOpen;
      if ($scope.courseSearchOpen) {
        setTimeout(function() {
          var el = document.getElementById('course-search-input');
          if (el) { el.focus(); }
        });
      }
    };
    angular.element($document).on('click', function(event) {
      var targetId = event.target.id || ($(event.target).parent().attr && $(event.target).parent().attr('id'));
      if (targetId !== 'course-search-icon' && targetId !== 'course-search-input') {
        $scope.courseSearchOpen = false;
        $scope.$apply();
      }
    });

    Restangular.all("courses").getList()
      .then(function(courses) {
        $scope.courses = [];
        $scope.archived = [];
        angular.forEach(courses, function(course) {
          courseRoles = roles.getByContext("course:" + course.id);
          if (course.archived) {
            if (courseRoles && courseRoles.roles.length && courseRoles.roles.includes('course-owner')) {
              course.role = courseRoles.roles[0].substring( courseRoles.roles[0].indexOf('-') + 1 );
              $scope.archived.push(course);
            }
          }
          else {
            if (courseRoles && courseRoles.roles.length) {
              course.role = courseRoles.roles[0].substring( courseRoles.roles[0].indexOf('-') + 1 );
            }
            $scope.courses.push(course);
            $scope.coursesById[ course.id ] = true;
          }
        });
      });

    Restangular.all("featured-courses").getList()
      .then(function(courses) {
        $scope.featuredCourses = [];
        angular.forEach(courses, function(featuredCourse) {
          featuredCourse.courseUrl = "/" + featuredCourse.ownerSlug + "/courses/" + featuredCourse.slug;
          if (featuredCourse.page) {
            featuredCourse.courseUrl += "#/" + featuredCourse.page;
          }
          $scope.featuredCourses.push(featuredCourse);
        });
      });

    $scope.gotoCourse = function(course) {
      $window.location.href = "/" + course.ownerSlug + "/courses/" + course.slug;
    }
  }]);

})(window.angular);
