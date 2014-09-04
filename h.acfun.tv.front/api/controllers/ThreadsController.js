/**
 * ThreadsController
 *
 * @module      :: Controller
 * @description    :: 贴子
 */

var gm = require('gm')
    , fs = require('fs')
    , path = require('path')
    , imageMagick = gm.subClass({ imageMagick: true });

module.exports = {

    /**
     * 获取单个帖子列表
     */
    index: function (req, res) {

        // ThreadsId 有效性
        var threadsId = Number(req.params.tid);
        if (isNaN(threadsId)) {
            return res.forbidden('贴子ID不合法');
        }

        // 翻页
        var pageIndex = Number(req.query.page);
        if (!pageIndex || isNaN(pageIndex) || pageIndex < 0) {
            pageIndex = 1;
        }

        // 缓存key
        var key = 'threads:' + threadsId + ':' + pageIndex;

        // API
        var isAPI = (req.params.format) ? true : false;

        if (isAPI) {
            key += ':api';
        }

        sails.services.cache.get(key)
            .then(function (cache) {
                if(isAPI){
                    return res.json(JSON.parse(cache));
                }
                res.send(200, cache);
            })
            .fail(function () {

                // 首先通过threadsID获得主串信息
                sails.models.threads.findOneById(threadsId)
                    .then(function(threads){

                        if(!threads){
                           return res.notFound();
                       }

                        var forum = sails.models.forum.findForumById(threads.forum);

                        sails.models.threads.count()
                            .where({parent:threadsId})
                            .then(function(replyCount){

                                var pageCount = Math.ceil(replyCount / 20);
                                pageCount = (!pageCount) ? 1 : pageCount;

                                // 获取回复信息
                                sails.models.threads.getReply(threadsId, pageIndex)
                                    .then(function (replys) {
                                        var output = {
                                            threads: threads,
                                            replys: replys,
                                            forum: forum,
                                            page: {
                                                title: 'No.' + threads.id,
                                                size: pageCount,
                                                page: pageIndex,
                                                isAPI: isAPI
                                            }
                                        };

                                        if (isAPI) {

                                            output['success'] = true;

                                            // 删除不需要的数据 & 转换时间戳

                                            if (forum) {
                                                forum['createdAt'] = (forum['createdAt']) ? new Date(forum['createdAt']).getTime() : null;
                                                forum['updatedAt'] = (forum['updatedAt']) ? new Date(forum['updatedAt']).getTime() : null;
                                            }

                                            if (threads) {
                                                delete threads['ip'];
                                                threads['createdAt'] = (threads['createdAt']) ? new Date(threads['createdAt']).getTime() : null;
                                                threads['updatedAt'] = (threads['updatedAt']) ? new Date(threads['updatedAt']).getTime() : null;
                                            }


                                            for (var i in replys) {
                                                if (replys[i]) {
                                                    delete replys[i]['ip'];
                                                    delete replys[i]['parent'];
                                                    delete replys[i]['recentReply'];
                                                    replys[i]['createdAt'] = (replys[i]['createdAt']) ? new Date(replys[i]['createdAt']).getTime() : null;
                                                    replys[i]['updatedAt'] = (replys[i]['updatedAt']) ? new Date(replys[i]['updatedAt']).getTime() : null;
                                                }
                                            }

                                            sails.services.cache.set(key, output);
                                            return res.json(output);

                                        }

                                        return res.render('threads/index', output, function (err, html) {
                                            if (err) {
                                                return res.serverError(err);
                                            } else {
                                                sails.services.cache.set(key, html);
                                                res.send(200, html);
                                            }
                                        });

                                    }).fail(function (err) {
                                        return res.serverError(err);
                                    });
                            });
                    })
                    .fail(function(err){
                        return res.serverError(err);
                    });

            });

    },
    // 创建
    create: function (req, res) {

        var data = req.body || {};

        if (req.method != 'POST') {
            return res.notFound();
        }

        // Skipper临时解决方案
        if(req._fileparser.form.bytesExpected > 4194304){
            return res.badRequest('文件大小不能超过4M (4,194,304 Byte)');
        }

        req.file('image').upload(function (uploadError, uploadedFiles) {

            // 1. 附件处理
            sails.models.threads.uploadAttachment(uploadError, uploadedFiles)
                .then(function (uploadedFilesPath) {

                    if (uploadedFilesPath && uploadedFilesPath.image && uploadedFilesPath.thumb) {
                        data.image = uploadedFilesPath.image;
                        data.thumb = uploadedFilesPath.thumb;
                    }

                    sails.models.threads.checkParentThreads(req.params.tid)
                        .then(function (parentThreads) {

                            // ip
                            data.ip = req.headers['x-forwarded-for'] ||
                                req.connection.remoteAddress ||
                                req.socket.remoteAddress ||
                                req.connection.socket.remoteAddress ||
                                '0.0.0.0';

                            // 饼干
                            data.uid = req.signedCookies.userId;

                            if (data.image && !data.content) {
                                data.content = '无正文';
                            } else if (!data.image && (!data.content || data.content.toString().trim().length < 1)) {
                                return res.badRequest('正文至少1个字');
                            }

                            if (sails.models.filter.test.word(data.content) || sails.models.filter.test.word(data.name) || sails.models.filter.test.word(data.title)) {
                                return res.badRequest('含有敏感词');
                            }

                            data.content = data.content
                                .replace(/<[^>]+>/gi, '')
                                .replace(/\r\n/g, "\n")
                                .replace(/\r/g, "\n")
                                .replace(/\r/g, "<br>")
                                .replace(/(\>\>No\.\d+)/g, "<font color=\"#789922\">$1</font>")
                                .replace(/(\>\>\d+)/g, "<font color=\"#789922\">$1</font>");

                            if (parentThreads && parentThreads.forum) {
                                var forum =  sails.models.forum.findForumById(parentThreads.forum);
                            } else if (req.params.forum) {
                                var forum =  sails.models.forum.findForumByName(req.params.forum);
                            } else {
                                var forum = null;
                            }

                            if (parentThreads && parentThreads.id){
                                data.parent = parentThreads.id;
                            }

                            if (!forum) {
                                return res.badRequest('版块不存在');
                            }

                            if (forum.lock) {
                                return res.badRequest('版块已经被锁定');
                            }

                            if (req.session.lastPostAt && (new Date().getTime() - req.session.lastPostAt < forum.cooldown * 1000)) {
                                if (!req.session.managerId) {
                                    return res.badRequest('发帖技能冷却中');
                                }
                            }

                            sails.models.threads
                                .create({
                                    uid: data.uid || '',
                                    name: data.name || '',
                                    email: data.email || '',
                                    title: data.title || '',
                                    content: data.content || '',
                                    image: data.image || '',
                                    thumb: data.thumb || '',
                                    lock: false,
                                    sage: data.sage || false,
                                    ip: data.ip || '0.0.0.0',
                                    forum: forum.id,
                                    parent: data.parent || '0',
                                    updatedAt: new Date()
                                })
                                .then(function(newThreads){
                                    sails.models.threads.handleParentThreads(parentThreads,newThreads)
                                        .then(function(){

                                            //通知清除缓存
                                            if(data.parent){
                                                sails.services.cache.update('threads:'+data.parent);
                                            }
                                            sails.services.cache.update('forum:'+forum.id);

                                            return res.ok('发帖成功');
                                        })
                                        .fail(function(err){
                                            // 事务回滚 删除之前创建的内容
                                            sails.models.threads.destroy({id:newThreads.id}).exec(function(){});
                                            return res.serverError(err);
                                        })
                                }).fail(function(err){
                                    return res.serverError(err);
                                });

                        })
                        .fail(function (replyThreadsError) {
                            return res.serverError(replyThreadsError.toString());
                        });
                })
                .fail(function (uploadAttachmentError) {
                    return res.serverError(uploadAttachmentError.toString());
                });
        });
    }
}
