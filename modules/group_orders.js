var express = require('express');
var _ = require('../libs/underscore-min.js');
var util = require('../modules/util.js');
var mongo_db  = require('../modules/mongo_db.js');
var async = require('async');
var cache_manager = require('../modules/cache_manager.js');

var group_orders = {};

group_orders.list = function (id, next) {
    if (id) {
        mongo_db.mongoFindOne("group_orders", id, next);
    } else {
        if(isDevelopment) {
            mongo_db.mongoFindAll("group_orders", next);
        } else {
            next(new Error("groupId is not provided"));
        }
    }
};

group_orders.listByUserId = function (userId, callback) {
    if (userId) {
        var doc = "group_orders";
        cache_manager.getGroupIdsForUser(userId, function (err, ids) {
            if (ids && !_.isEmpty(ids)) {
                async.map(ids, function (id, next1) {
                    mongo_db.mongoFindOne(doc, id, next1);
                }, function (err, result) {
                    result.sort(function (a, b) {
                        return b.created_at - a.created_at;
                    });
                    callback(err, result);
                });
            } else {
                async.parallel([
                    function (next) {
                        var queryObj = {"user_info.userId": userId};
                        mongo_db.mongoFindIds(doc, queryObj, next);
                    },
                    function (next) {
                        var aggregates = [];
                        aggregates.push({$unwind: "$orders"});
                        aggregates.push({$match: {"orders.user_info.userId": userId}});
                        aggregates.push({$project: {_id: 0, id: 1}});
                        mongo_db.mongoGetAggregateIds(doc, aggregates, next);
                    }
                ], function (err, ids) {
                    console.log("ids", ids);
                    ids = _.flatten(ids);
                    ids = _.compact(ids);
                    ids = _.uniq(ids);
                    async.map(ids, function (id, next1) {
                        mongo_db.mongoFindOne(doc, id, next1);
                    }, function (err, result) {
                        result.sort(function (a, b) {
                            return b.created_at - a.created_at;
                        });
                        cache_manager.rpush_ids_to_userId_list(userId, ids, function () {
                            callback(err, result);
                        })
                    });
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
        mongo_db.mongoUpdate("group_orders", queryObj, updateObj, function (err, result, isInsert) {
            if (isInsert) {
                if (updateObj && updateObj.user_info && updateObj.user_info.userId) {
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

group_orders.updatePO = function updatePO(updateObj, next) {
    if(updateObj && updateObj.order_id) {
        var queryObj = {id: updateObj.group_order_id, "orders.id": updateObj.order_id};
        mongo_db.mongoUpdatePO(queryObj, updateObj.order, function (err, result, isInsert) {
            if (isInsert) {
                var userId = updateObj.order.user_info ? updateObj.order.user_info.userId : "";
                cache_manager.rpush_single_id_to_userId_list(userId, updateObj.group_order_id, function () {
                    next(err, result);
                });
            } else {
                next(err, result);
            }
        });
    } else {
        next(new Error("provided object is empty"));
    }
};

group_orders.remove = function (authUser, group_order_id, next) {
    var queryObj = {id: group_order_id};
    mongo_db.mongoRemove("group_orders", authUser, queryObj, function (err, result, foundObj) {
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
            cache_manager.delById("group_orders", group_order_id, function () {
                next(err, result);
            });
        });
    });
};

module.exports = group_orders;
