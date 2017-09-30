var express = require('express');
var _ = require('../libs/underscore-min.js');
var util = require('../modules/util.js');
var async = require('async');
var cache_manager = require('../modules/cache_manager.js');

var group_orders = {};

group_orders.list = function (id, next) {
    var orderBy = {created_at: -1};
    if (id) {
        cache_manager.getByGroupId(id, next);
    } else {
        util.mongoFind("group_orders", {}, orderBy, next);
    }
};

group_orders.listByUserId = function (userId, callback) {
    if (userId) {
        cache_manager.getGroupIdsForUser(userId, function (err, ids) {
            if (ids && !_.isEmpty(ids)) {
                async.map(ids, function(id, next){
                    cache_manager.getByGroupId(id, next);
                }, callback);
            } else {
                async.parallel([
                    function (next) {
                        var queryObj = {"user_info.userId": userId};
                        var orderBy = {created_at: -1};
                        util.mongoFind("group_orders", queryObj, orderBy, next);
                    },
                    function (next) {
                        var aggregates = [];
                        aggregates.push({$unwind: "$orders"});
                        aggregates.push({$match: {"orders.user_info.userId": userId}});
                        aggregates.push({$project: {_id: 0}});
                        aggregates.push({ $sort : { created_at : -1}});
                        util.mongoAggregate("group_orders", aggregates, next);
                    }
                ], function (err, result) {
                    result = _.flatten(result);
                    result = _.compact(result);
                    result = _.uniq(result, 'id');
                    result.sort(function (a, b) {
                        return a.created_at - b.created_at;
                    });

                    var ids = _.pluck(result, "id");
                    cache_manager.rpush_ids_to_userId_list(userId, ids, function () {
                        callback(err, result);
                    })
                });
            }
        });
    } else {
        callback(new Error("provided userId is empty"));
    }
};

group_orders.update = function (updateObj, next) {
    if(updateObj && updateObj.group_order_id) {
        var queryObj = {};
        queryObj.id = updateObj.group_order_id;
        updateObj.id = updateObj.group_order_id;
        delete  updateObj.group_order_id;
        util.mongoUpdate("group_orders", queryObj, updateObj, function (err, result, isInsert) {
            if(isInsert){
                if(updateObj && updateObj.user_info && updateObj.user_info.userId){
                 cache_manager.rpush_single_id_to_userId_list(updateObj.user_info.userId, updateObj.id, function () {
                    next(err, result);
                 });
                } else {
                    next(err, result);
                }
            } else {
                next(err, result);
            }
        });
    } else {
        next(new Error("provided object is empty"));
    }
};

group_orders.updatePO = function (updateObj, next) {
    if(updateObj && updateObj.order_id) {
        var queryObj = {id: updateObj.group_order_id, "orders.id": updateObj.order_id};
        util.mongoUpdatePO(queryObj, updateObj.order, function (err, result, isInsert) {
            cache_manager.delByGroupId(updateObj.group_order_id, function () {
                if (isInsert) {
                    var userId = updateObj.order.user_info ? updateObj.order.user_info.userId : "";
                    cache_manager.rpush_single_id_to_userId_list(userId, updateObj.group_order_id, function () {
                        next(err, result);
                    });
                } else {
                    next(err, result);
                }
                next(err, result);
            });
        });
    } else {
        next(new Error("provided object is empty"));
    }
};

group_orders.remove = function (authUser, group_order_id, next) {
    var queryObj = {id: group_order_id};
    util.mongoRemove("group_orders", authUser, queryObj, function (err, result, foundObj) {
        var userIds = [];
        if (foundObj && !_.isEmpty(foundObj)) {
            var user_info = _.pluck(foundObj.orders, "user_info");
            userIds = _.pluck(user_info, "userId");
            if (foundObj.user_info) {
                userIds.push(foundObj.user_info.userId);
            }
            userIds = _.compact(userIds);
            userIds = _.uniq(userIds);
        }
        cache_manager.remove_ids_from_userId_list(userIds, group_order_id, function () {
            cache_manager.delByGroupId(group_order_id, function () {
                next(err, result);
            });
        });
    });
};

module.exports = group_orders;
