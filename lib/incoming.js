"use strict";
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const Readable = require("stream").Readable;
const tea = require('crypto-tea');
const ecdh = require("./ecdh");
const {parseMessage, buildRawMessage} = require("./message");
const {downloadRichMsg} = require("./service");
const common = require("./common");
const pb = require("./pb");
const jce = require("./jce");
const outgoing = require("./outgoing");
const event = require("./event");
const toInt = common.toInt;

//common----------------------------------------------------------------------------------------------

/**
 * @param {Buffer} buf 
 * @returns {Object}
 */
function parseSSO(buf) {
    const stream = Readable.from(buf, {objectMode:false});
    stream.read(0);
    if (stream.read(4).readInt32BE() - 4 > stream.readableLength) {
        throw new Error("dropped");
    }
    const seq_id = stream.read(4).readInt32BE();
    const retcode = stream.read(4).readInt32BE();
    if (retcode) {
        throw new Error("return code unsuccessful: " + retcode);
    }
    stream.read(stream.read(4).readInt32BE() - 4);
    const command_name = stream.read(stream.read(4).readInt32BE() - 4).toString();
    const session_id = stream.read(stream.read(4).readInt32BE() - 4);
    if (command_name === "Heartbeat.Alive") {
        return {
            seq_id, command_name, session_id, payload: Buffer.alloc(0)
        };
    }

    const compressed = stream.read(4).readInt32BE();
    var payload;
    if (compressed === 0) {
        stream.read(4);
        payload = stream.read();
    } else if (compressed === 1) {
        stream.read(4);
        payload = zlib.unzipSync(stream.read());
    } else if (compressed === 8) {
        payload = stream.read();
    } else
        throw new Error("unknown compressed flag: " + compressed)
    return {
        seq_id, command_name, session_id, payload
    };
}

/**
 * @param {Buffer} buf 
 * @returns {Buffer}
 */
function parseOICQ(buf) {
    const stream = Readable.from(buf, {objectMode:false});
    if (stream.read(1).readUInt8() !== 2) {
        throw new Error("unknown flag");
    }
    stream.read(12);
    const encrypt_type = stream.read(2).readUInt16BE();
    stream.read(1)
    if (encrypt_type === 0) {
        const encrypted = stream.read(stream.readableLength - 1);
        let decrypted = tea.decrypt(encrypted, ecdh.share_key);
        return decrypted;
    } else if (encrypt_type === 4) {
        throw new Error("todo");
    } else
        throw new Error("unknown encryption method: " + encrypt_type);
}

//tlv----------------------------------------------------------------------------------------------

/**
 * @param {Readable} stream 
 * @param {Number} size 
 * @returns {Object}
 */
function readTlv(stream, size) {
    const t = {};
    var k;
    while(true) {
        if (stream.readableLength < size)
            break;
        if (size === 1)
            k = stream.read(1).readUInt8();
        else if (size === 2)
            k = stream.read(2).readUInt16BE();
        else if (size === 4)
            k = stream.read(4).readInt32BE();
        if (k === 255)
            break;
        t[k] = stream.read(stream.read(2).readUInt16BE())
    }
    return t;
}

function decodeT161(data, c) {
    const stream = Readable.from(data, {objectMode:false});
    stream.read(2);
    c.rollback_sig = readTlv(stream, 2)[0x172];
}
function decodeT119(data, c) {
    const reader = Readable.from(tea.decrypt(data, c.device_info.tgtgt_key), {objectMode:false});
    reader.read(2);
    const t = readTlv(reader, 2);
    if (t[0x130])
        decodeT130(t[0x130], c);
    c.t528 = t[0x528];
    c.t530 = t[0x530];
    c.ksid = t[0x108];
    if (t[0x186])
        decodeT186(t[0x186], c);
    if (t[0x11a])
        [c.nickname, c.age, c.sex] = readT11A(t[0x11a]);
    c.sign_info = {
        bitmap:         0,
        tgt:            t[0x10a],
        tgt_key:        t[0x10d],
        st_key:         t[0x10e],
        st_web_sig:     t[0x103],
        s_key:          t[0x120],
        d2:             t[0x143],
        d2key:          t[0x305],
        ticket_key:     t[0x134],
        device_token:   t[0x322],
    };
}
function decodeT130(data, c) {
    const stream = Readable.from(data, {objectMode:false});
    stream.read(2);
    c.time_diff = stream.read(4).readInt32BE() - common.timestamp();
    c.t149 = stream.read(4);
}
function decodeT186(data, c) {
    c.pwd_flag = data[1] === 1;
}
function readT11A(data) {
    const stream = Readable.from(data, {objectMode:false});
    stream.read(2);
    const age = stream.read(1).readUInt8();
    const sex = friend_sex_map[stream.read(1).readUInt8()];
    let nickname = stream.read(stream.read(1).readUInt8() & 0xff);
    nickname = nickname ? nickname.toString() : "";
    return [nickname, age, sex];
}

//login----------------------------------------------------------------------------------------------

/**
 * @returns {void}
 */
function decodeLoginResponse(blob, c) {
    const stream = Readable.from(blob, {objectMode:false});
    stream.read(2);
    const type = stream.read(1).readUInt8();
    stream.read(2);
    const t = readTlv(stream, 2);
    if (type === 0) { //success
        c.t150 = t[0x150];
        if (t[0x161])
            decodeT161(t[0x161], c);
        decodeT119(t[0x119], c);
        return event.emit(c, "internal.login");
    }
    if (type === 2) { //captcha
        c.t104 = t[0x104]
        if (t[0x192]) { //slider captcha, not supported yet
            c.logger.error("收到滑动验证码，暂不支持。");
            return event.emit(c, "system.login.error", {
                message: `[登陆失败]暂不支持滑动验证码。`
            });
        }
        if (t[0x165]) { //image captcha
            const stream = Readable.from(t[0x105], {objectMode:false});
            const signLen = stream.read(2).readUInt16BE();
            stream.read(2);
            c.captcha_sign = stream.read(signLen);
            const image = stream.read();
            const filepath = path.join(c.dir, `captcha.jpg`);
            fs.writeFileSync(filepath, image);
            c.logger.info(`收到图片验证码，已保存到文件(${filepath})，请查看并输入: `);
            return event.emit(c, "system.login.captcha", {image});
        }
        c.logger.error("收到未知格式的验证码，暂不支持。");
        return event.emit(c, "system.login.error", {
            message: `[登陆失败]未知格式的验证码。`
        });
    }

    if (type === 160) {
        const url = t[0x204].toString();
        c.logger.info("需要验证设备信息，验证地址：" + url);
        return event.emit(c, "system.login.device", {url});
    }

    if (type === 204) {
        c.t104 = t[0x104];
        c.logger.info("login...");
        return c.write(outgoing.buildDeviceLoginRequestPacket(t[0x402], c));
    }

    if (t[0x149]) {
        const stream = Readable.from(t[0x149], {objectMode:false});
        stream.read(2);
        const title = stream.read(stream.read(2).readUInt16BE()).toString();
        const content = stream.read(stream.read(2).readUInt16BE()).toString();
        const message = `[${title}]${content}`;
        c.logger.error(message);
        return event.emit(c, "system.login.error", {message});
    }

    if (t[0x146]) {
        const stream = Readable.from(t[0x146], {objectMode:false});
        const version = stream.read(4);
        const title = stream.read(stream.read(2).readUInt16BE()).toString();
        const content = stream.read(stream.read(2).readUInt16BE()).toString();
        const message = `[${title}]${content}`;
        c.logger.error(message);
        return event.emit(c, "system.login.error", {message});
    }

    c.logger.error("[登陆失败]未知错误。");
    event.emit(c, "system.login.error", {
        message: `[登陆失败]未知错误。`
    });
}

/**
 * @returns {boolean}
 */
function decodeClientRegisterResponse(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    return parent[9]?true:false;
}
function decodePushReqEvent(blob, c, seq) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    c.write(outgoing.buildConfPushResponsePacket(parent[1], parent[3], parent[2], seq, c));
    let ip, port;
    if (parent[1] === 1) {
        let server = jce.decode(parent[2])[1][0];
        server = jce.decode(server);
        ip = server[0], port = server[1];
    }
    //更换服务器理论上可以获得更好的性能和连接稳定性，一般来说无视这个包也没什么问题
    //据说前段时间服务器不稳定导致的频繁掉线和这个有关
    event.emit(c, "internal.change-server", {ip, port});
}

//message----------------------------------------------------------------------------------------------------

/**
 * @returns {void}
 */
async function decodeMessageSvcResponse(blob, c) {
    const o = pb.decode("GetMessageResponse", blob);
    if (o.result > 0 || !o.uinPairMsgs){
        c.sync_finished = true;
        return;
    }
    // common.log(o);
    c.sync_cookie = o.syncCookie;
    const rubbish = [];
    for (let v of o.uinPairMsgs) {
        if (!v.messages) continue;
        for (let msg of v.messages) {
            const head = msg.head, body = msg.body;
            const type = head.msgType, time = toInt(head.msgTime);
            head.msgType = 187;
            rubbish.push(head);
            if (!c.sync_finished)
                continue;
            let user_id = toInt(head.fromUin);
            if (user_id === c.uin)
                continue;
            // if (v.lastReadTime === -1 || v.lastReadTime > head.msgTime)
            //     continue;
            let update_flag = false;
            if (!c.seq_cache.has(user_id)) {
                c.seq_cache.set(user_id, head.msgSeq);
            } else {
                const seq = c.seq_cache.get(user_id);
                if (seq - head.msgSeq >= 0 && seq - head.msgSeq < 1000)
                    continue;
                else {
                    update_flag = Math.abs(head.msgSeq - seq) > 1 || head.msgSeq % 10 === 0;
                    c.seq_cache.set(user_id, head.msgSeq);
                }
            }
            if (type === 33) {
                (async()=>{
                    const group_id = common.uin2code(user_id);
                    user_id = toInt(head.authUin);
                    try {
                        const ginfo = (await c.getGroupInfo(group_id)).data;
                        if (user_id === c.uin) {
                            c.logger.info(`更新了群列表，新增了群：${group_id}`);
                            c.getGroupMemberList(group_id);
                        } else {
                            ginfo.member_count++;
                            ginfo.last_join_time = common.timestamp();
                            await c.getGroupMemberInfo(group_id, user_id);
                        }
                    } catch (e) {}
                    event.emit(c, "notice.group.increase", {
                        group_id, user_id,
                        nickname: head.authNick
                    });
                })();
                continue;
            }
            let sub_type, message_id, font;
            const sender = Object.assign({user_id}, c.fl.get(user_id));
            if (type === 141) {
                sub_type = "other";
                if (head.c2cTmpMsgHead && head.c2cTmpMsgHead.groupCode) {
                    sub_type = "group";
                    const group_id = toInt(head.c2cTmpMsgHead.groupCode);
                    sender.group_id = group_id;
                }
            } else if (type === 166) { //208语音
                sub_type = c.fl.has(user_id) ? "friend" : "single";
            } else if (type === 167) {
                sub_type = "single";
            } else {
                continue;
            }
            if (!sender.nickname) {
                const stranger = (await c.getStrangerInfo(user_id, update_flag)).data;
                if (stranger) {
                    stranger.group_id = sender.group_id;
                    Object.assign(sender, stranger);
                    c.sl.set(user_id, stranger);
                }
            }
            if (body.richText && body.richText.elems && body.richText.attr) {
                message_id = common.genGroupMessageId(user_id, head.msgSeq, body.richText.attr.random);
                font = body.richText.attr.fontName;
                let res;
                (async()=>{
                    try {
                        res = await getMsgFromElems(body.richText, c);
                    } catch (e) {return}
                    const {chain, raw_message} = res;
                    if (raw_message) {
                        c.logger.info(`recv from: [Private: ${user_id}(${sub_type})] ` + raw_message);
                        event.emit(c, "message.private." + sub_type, {
                            message_id, user_id, message: chain, raw_message, font, sender, time
                        });
                    }
                })();
            }
        }
    }

    if (rubbish.length)
        c.write(outgoing.buildDeleteMessageRequestPacket(rubbish, c));
    if (o.syncFlag !== 2) {
        c.write(outgoing.buildGetMessageRequestPacket(o.syncFlag, c));
    } else if (!c.sync_finished) {
        c.sync_finished = true;
        c.logger.info("初始化完毕，开始处理消息。")
        event.emit(c, "system.online");
    }
}

function decodePushNotifyEvent(blob, c) {
    if (!c.sync_finished) return;
    const nested = jce.decodeWrapper(blob.slice(15));
    const parent = jce.decode(nested);
    switch (parent[5]) {
        case 33:
        case 141:
        case 166:
        case 167:
            c.write(outgoing.buildGetMessageRequestPacket(0, c));
            break;
        case 84:
        case 87:
            c.write(outgoing.buildNewGroupRequestPacket(c));
            break;
        case 187:
            c.write(outgoing.buildNewFriendRequestPacket(c));
            break;
    }
}

async function decodeGroupMessageEvent(blob, c) {
    if (!c.sync_finished) return;
    const o = pb.decode("PushMessagePacket", blob);
    // common.log(o);
    const head = o.message.head, body = o.message.body, user_id = toInt(head.fromUin), time = toInt(head.msgTime);
    const group = head.groupInfo, group_id = toInt(group.groupCode), group_name = group.groupName.toString();
    const message_id = common.genGroupMessageId(group_id, head.msgSeq, body.richText.attr.random);
    if (user_id === c.uin)
        c.emit(`interval.${group_id}.${body.richText.attr.random}`, message_id);

    c.getGroupInfo(group_id);

    const font = body.richText.attr.fontName, card = group.groupCard;
    let anonymous = null, user = null;
    if (user_id === 80000000) {
        anonymous = {
            id:0, name: card, flag: ""
        };
    } else {
        try {
            user = (await c.getGroupMemberInfo(group_id, user_id)).data;
            user.card = card;
            if (time > user.last_sent_time) {
                user.last_sent_time = time;
                c.gl.get(group_id).last_sent_time = time;
            }
        } catch (e) {}
    }

    if (user_id === c.uin && c.ignore_self)
        return;

    if (user) {
        var {nickname, sex, age, area, level, role, title} = user;
    } else {
        var nickname = card, sex = "unknown", age = 0, area = "", level = 0, role = "member", title = "";
    }
    const sender = {
        user_id, nickname, card, sex, age, area, level, role, title
    };

    let res;
    try {
        res = await getMsgFromElems(body.richText, c);
    } catch (e) {return}
    let {chain, raw_message} = res;

    try {
        if (chain[0].type === "notice") {
            const v = chain[0];
            raw_message = "";
            event.emit(c, "notice.group.notice", {
                group_id, group_name, user_id, sender, time, title: "群公告", content: chain[0].data.text
            });
        }
        if (chain[0].type === "file") {
            const v = chain[0];
            let resp = await c.send(outgoing.buildGroupFileUrlRequestPacket(group_id, v.data.busId, v.data.filePath.toString(), c));
            resp = resp.downloadFileRsp;
            v.data = {
                name:   v.data.fileName,
                url:    `http://${resp.downloadIp}/ftn_handler/${resp.downloadUrl.toString("hex")}/?fname=${v.data.fileName}`,
                size:   toInt(v.data.fileSize),
                md5:    resp.md5.toString("hex"),
                duration: v.data.int64DeadTime.low,
            };
            raw_message = buildRawMessage(v);
            event.emit(c, "notice.group.file", {
                group_id, group_name, user_id, sender, time, file: v.data
            });
        }
    } catch (e) {return}

    if (!raw_message)
        return;

    const sub_type = anonymous ? "anonymous" : "normal";
    c.logger.info(`recv from: [Group: ${group_name}(${group_id}), Member: ${card}(${user_id})] ` + raw_message);
    event.emit(c, "message.group." + sub_type, {
        message_id, group_id, group_name, user_id, anonymous, message: chain, raw_message, font, sender, time
    });
}

async function decodeDiscussMessageEvent(blob, c, seq) {
    const o = pb.decode("PushMessagePacket", blob);
    c.write(outgoing.buildOnlinePushResponsePacket(o.svrip, seq, [], c));
    if (!c.sync_finished) return;
    // common.log(o);
    const head = o.message.head, body = o.message.body, user_id = toInt(head.fromUin), time = toInt(head.msgTime);
    const discuss = head.discussInfo, discuss_id = toInt(discuss.discussUin), discuss_name = discuss.discussName.toString();

    if (user_id === c.uin && c.ignore_self)
        return;

    const font = body.richText.attr.fontName, card = discuss.discussRemark, nickname = card;
    const sender = {
        user_id, nickname, card
    };

    let res;
    try {
        res = await getMsgFromElems(body.richText, c);
    } catch (e) {return}
    let {chain, raw_message} = res;

    if (!raw_message)
        return;

    c.logger.info(`recv from: [Discuss: ${discuss_name}(${discuss_id}), Member: ${card}(${user_id})] ` + raw_message);
    event.emit(c, "message.discuss", {
        discuss_id, discuss_name, user_id, message: chain, raw_message, font, sender, time
    });
}

async function getMsgFromElems(rich, c) {
    let res = parseMessage(rich);
    if (typeof res === "string") {
        const resp = await c.send(outgoing.buildMultiApplyDownRequestPacket(res, 1, c));
        res = await downloadRichMsg(resp);
        res = parseMessage(res.msg[0].body.richText);
    }
    return res;
}

//list&info rsp----------------------------------------------------------------------------------------------------

const friend_sex_map = {
    "0":"unknown", "1":"male", "2":"female"
};
const group_sex_map = {
    "-1":"unknown", "0":"male", "1":"female"
};
const group_role_map = {
    "1":"member", "2":"admin", "3":"owner"
};

/**
 * @returns {Number} 好友总数
 */
function decodeFriendListResponse(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    for (let v of parent[7]) {
        v = jce.decode(v);
        c.fl.set(v[0], {
            user_id:    v[0],
            nickname:   v[14],
            sex:        friend_sex_map[v[31]],
            age:        0,
            area:       "unknown",
            remark:     v[3],
        })
    }
    return parent[5];
}

function decodeGroupListResponse(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    for (let v of parent[5]) {
        v = jce.decode(v);
        c.gl.set(v[1], {
            group_id:           v[1],
            group_name:         v[4],
            member_count:       v[19],
            max_member_count:   v[29],
            owner_id:           v[23],
            last_join_time:     v[27],
            last_sent_time:     0,
            shutup_time_whole:  v[9] & 0xffffffff,
            shutup_time_me:     v[10],
            create_time:        0,
            grade:              0,
            max_admin_count:    0,
            active_member_count:0,
            update_time:        0,
        });
    }
}
function decodeGroupInfoResponse(blob, c) {
    let o =  pb.decode("D88DRspBody", pb.decode("OIDBSSOPkg", blob).bodybuffer).groupList[0];
    const group_id = toInt(o.groupCode);
    o = o.groupInfo;
    if (!o) {
        c.gl.delete(group_id);
        c.gml.delete(group_id);
        return null;
    }
    const ginfo = {
        group_id:           group_id,
        group_name:         o.longGroupName ? o.longGroupName : o.groupName,
        member_count:       o.groupMemberNum,
        max_member_count:   o.groupMemberMaxNum,
        owner_id:           toInt(o.groupOwner),
        last_join_time:     o.cmduinJoint32ime,
        last_sent_time:     o.cmduinLastMsgTime,
        shutup_time_whole:  o.shutupTimestamp & 0xffffffff,
        shutup_time_me:     o.shutupTimestampMe,
        create_time:        o.groupCreateTime,
        grade:              o.groupGrade,
        max_admin_count:    o.groupAdminMaxNum,
        active_member_count:o.activeMemberNum,
        update_time:        common.timestamp(),
    };
    c.gl.set(group_id, ginfo);
    return ginfo;
}

/**
 * @returns {JSON}
 *  @field {Map} map
 *  @field {Number} next 下一个uin
 */
function decodeGroupMemberListResponse(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    const group_id = parent[1];
    const map = new Map(), next = parent[4];
    for (let v of parent[3]) {
        v = jce.decode(v);
        map.set(v[0], {
            group_id:           group_id,
            user_id:            v[0],
            nickname:           v[4],
            card:               v[8],
            sex:                group_sex_map[v[3]],
            age:                v[2],
            area:               "unknown",
            join_time:          v[15],
            last_sent_time:     v[16],
            level:              v[14],
            role:               v[18] ? "admin" : "member",
            unfriendly:         false,
            title:              v[23],
            title_expire_time:  v[24]&0xffffffff,
            card_changeable:    true,
            update_time:        0,
        });
    }
    try {
        const owner = c.gl.get(group_id).owner_id;
        map.get(owner).role = "owner";
    } catch (e) {}
    return {map, next};
}
function decodeGroupMemberInfoResponse(blob, c) {
    let o = pb.decode("GetCardRspPkg", blob);
    const group_id = toInt(o.groupCode);
    o = o.body;
    if (!o.role) return null;
    const uin = toInt(o.uin);
    if (o.sex === undefined) o.sex = -1;
    return {
        group_id:           group_id,
        user_id:            uin,
        nickname:           o.nickname,
        card:               o.card,
        sex:                Reflect.has(o, "sex")?group_sex_map[o.sex]:"unknown",
        age:                o.age,
        area:               Reflect.has(o, "area")?o.area:"unknown",
        join_time:          toInt(o.joinTime),
        last_sent_time:     toInt(o.lastSentTime),
        level:              o.level,
        rank:               o.rank,
        role:               group_role_map[o.role],
        unfriendly:         false,
        title:              Reflect.has(o, "title")?o.title:"",
        title_expire_time:  Reflect.has(o, "titleExpireTime")?o.titleExpireTime:-1,
        card_changeable:    true,
        update_time:        common.timestamp(),
    };
}

function decodeStrangerInfoResponse(blob, c) {
    const nested = jce.decodeWrapper(blob);
    for (let v of nested) {
        v = jce.decode(v);
        const area = (v[13]+" "+v[14]+" "+v[15]).trim();
        const user = {
            user_id: v[1],
            nickname: v[5],
            sex: group_sex_map[v[3]],
            age: v[4],
            area: area?area:"unknown",
        };
        let o = c.fl.get(v[1]);
        if (!o)
            o = c.sl.get(v[1]);
        if (o) {
            o.area = user.area;
            if (user.sex !== "unknown")
                o.sex = user.sex;
            if (user.age)
                o.age = user.age;
        }
        return user;
    }
    return null;
}

//request rsp----------------------------------------------------------------------------------------------------

function decodeNewFriendResponse(blob, c) {
    const o = pb.decode("RspSystemMsgNew", blob);
    // common.log(o)
    const v = o.friendmsgs[0];
    const time = toInt(v.msgTime);
    const user_id = toInt(v.reqUin);
    const flag = common.genFriendRequestFlag(user_id, v.msgSeq);
    c.logger.info(`收到 ${user_id}(${v.msg.reqUinNick}) 的加好友请求 (flag: ${flag})`);
    event.emit(c, "request.friend.add", {
        user_id,
        nickname:   v.msg.reqUinNick,
        source:     v.msg.msgSource,
        comment:    v.msg.msgAdditional,
        sex:        v.msg.reqUinGender===0?"male":(v.msg.reqUinGender===1?"famale":"unknown"),
        age:        v.msg.reqUinAge,
        flag, time
    });
}
function decodeNewGroupResponse(blob, c) {
    const o = pb.decode("RspSystemMsgNew", blob);
    // common.log(o)
    const v = o.groupmsgs[0];
    if (v.msg.subType !== 1) return;
    const time = toInt(v.msgTime);
    const group_id = toInt(v.msg.groupCode); 
    if (v.msg.groupMsgType === 1) {
        const user_id = toInt(v.reqUin);
        const flag = common.genGroupRequestFlag(user_id, group_id, v.msgSeq);
        c.logger.info(`用户 ${user_id}(${v.msg.reqUinNick}) 请求加入群 ${group_id}(${v.msg.groupName}) (flag: ${flag})`);
        event.emit(c, "request.group.add", {
            group_id, user_id,
            group_name: v.msg.groupName,
            nickname:   v.msg.reqUinNick,
            comment:    v.msg.msgAdditional,
            flag, time
        });
    } else if (v.msg.groupMsgType === 2) {
        const user_id = toInt(v.msg.actionUin);
        const flag = common.genGroupRequestFlag(user_id, group_id, v.msgSeq, 1);
        c.logger.info(`用户 ${user_id}(${v.msg.actionUinNick}) 邀请你加入群 ${group_id}(${v.msg.groupName}) (flag: ${flag})`);
        event.emit(c, "request.group.invite", {
            group_id, user_id,
            group_name: v.msg.groupName,
            nickname:   v.msg.actionUinNick,
            role:       v.msg.groupInviterRole === 1 ? "member" : "admin",
            flag, time
        });
    }
}

function decodeSystemActionResponse(blob, c) {
    const o = pb.decode("RspSystemMsgAction", blob);
    return o.head.result === 0;
}

//online push------------------------------------------------------------------------------------------------

function decodeOnlinePushEvent(blob, c, seq) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    const list = parent[2];
    const rubbish = [];
    for (let v of list) {
        v = jce.decode(v);
        rubbish.push(jce.encodeNested([
            c.uin, v[1], v[3], v[8], 0,0,0,0,0,0,0
        ]))
        if (!c.sync_finished) continue;
        const time = v[5];
        if (v[2] === 528) {
            let data = jce.decode(v[6]);
            if (data[0] === 0x8A || data[0] === 0x8B) {
                data = pb.decode("Sub8A", data[10]);
                data = data.msgInfo[0];
                const user_id = toInt(data.fromUin);
                event.emit(c, "notice.friend.recall", {
                    user_id, message_id: common.genGroupMessageId(user_id, data.msgSeq, data.msgRandom)
                });
            } else if (data[0] === 0xB3) {
                data = pb.decode("SubB3", data[10]);
                const user_id = toInt(data.msgAddFrdNotify.uin), nickname = data.msgAddFrdNotify.nick;
                c.fl.set(user_id, {
                    user_id, nickname,
                    sex: "unknown",
                    age: 0,
                    area: "unknown",
                    remark: nickname,
                });
                c.sl.delete(user_id);
                c.getStrangerInfo(user_id);
                c.logger.info(`更新了好友列表，新增了好友 ${user_id}(${nickname})`);
                event.emit(c, "notice.friend.increase", {
                    user_id, nickname
                });
            } else if (data[0] === 0xD4) {
                data = pb.decode("SubD4", data[10]);
                const group_id = toInt(data.groupCode);
                c.getGroupInfo(group_id, true);
            }
            if (data[0] === 0x3B) {
                data = pb.decode("Sub3B", data[10])
                const group_id = toInt(data.groupCode);
                event.emit(c, "notice.group.setting", {
                    group_id, user_id: -1,
                    enable_show_title: data.enableShowTitle > 0
                });
            }
            if (data[0] === 0x44) {}
            if (data[0] === 0x27) {
                data = pb.decode("Sub27", data[10]).sub27[0];
                if (data.type === 80) {
                    const o = data.msgNewGrpName;
                    const group_id = toInt(o.groupCode);
                    if (!o.authUin)
                        continue;
                    try {
                        c.gl.get(group_id).group_name = o.entry.name;
                    } catch (e) {}
                    event.emit(c, "notice.group.setting", {
                        group_id,
                        user_id: toInt(o.authUin),
                        group_name: o.entry.name
                    });
                }
                if (data.type === 5) {
                    let user_id = toInt(data.msgDelFrdNotify.uin), nickname = null;
                    try {
                        nickname = c.fl.get(user_id).nickname;
                        c.fl.delete(user_id);
                    } catch (e) {}
                    c.logger.info(`更新了好友列表，删除了好友 ${user_id}(${nickname})`);
                    event.emit(c, "notice.friend.decrease", {
                        user_id, nickname
                    });
                }
                if (data.type === 20) {
                    // 20002昵称 20009性别 20031生日 23109农历生日 20019说明 20032地区 24002故乡
                    const user_id = toInt(data.msgProfile.uin);
                    const o = data.msgProfile.profile;
                    let key, value;
                    if (o.type === 20002) {
                        key = "nickname";
                        value = o.value.toString();
                    } else if (o.type === 20009) {
                        key = "sex";
                        value = friend_sex_map[o.value[0]];
                    } else if (o.type === 20031) {
                        key = "age";
                        value = new Date().getFullYear() - o.value.readUInt16BE();
                    } else if (o.type === 20019) {
                        key = "description";
                        value = o.value.toString();
                    } else {
                        continue;
                    }
                    try {
                        c.fl.get(user_id)[key] = value;
                    } catch (e) {}
                    if (user_id === c.uin)
                        c[key] = value;
                    else {
                        const e = {user_id};
                        e[key] = value;
                        event.emit(c, "notice.friend.profile", e);
                    }
                }
                if (data.type === 60) {
                    const user_id = toInt(data.msgNewSign.uin);
                    const sign = data.msgNewSign.sign;
                    try {
                        c.fl.get(user_id).signature = sign;
                    } catch (e) {}
                    if (user_id === c.uin)
                        c.signature = sign;
                    else
                        event.emit(c, "notice.friend.profile", {
                            user_id, signature: sign
                        });
                }
                if (data.type === 40) {
                    try {
                        const o = data.msgNewRemark.entry, uin = toInt(o.uin);
                        if (o.type > 0) continue; //0好友备注 1群备注
                        c.fl.get(uin).remark = o.remark;
                    } catch (e) {}
                }
                if (data.type === 21) {
                    // 群头像增加 <Buffer 0a 1a 08 00 10 15 5a 14 08 01 10 9f dd 95 a1 04 18 9f dd 95 a1 04 20 f5 ef e8 b1 01>
                }
                
            }
        } else if (v[2] === 732) {
            const group_id = v[6].readUInt32BE();
            if (v[6][4] === 0x0C) {
                const operator_id = v[6].readUInt32BE(6);
                const user_id = v[6].readUInt32BE(16);
                const duration = v[6].readUInt32BE(20);
                try {
                    if (user_id === 0)
                        c.gl.get(group_id).shutup_time_whole = duration & 0xffffffff;
                    else if (user_id === c.uin)
                        c.gl.get(group_id).shutup_time_me = duration ? (time + duration) : 0;
                } catch (e) {}
                event.emit(c, "notice.group.ban", {
                    group_id, operator_id, user_id, duration
                });
            }
            if (v[6][4] === 0x11) {
                const data = pb.decode("NotifyMsgBody", v[6].slice(7));
                const operator_id = toInt(data.optMsgRecall.uin);
                const msg = data.optMsgRecall.recalledMsgList[0];
                const user_id = toInt(msg.authorUin);
                const message_id = common.genGroupMessageId(group_id, msg.seq, msg.msgRandom);
                event.emit(c, "notice.group.recall", {
                    group_id, user_id, operator_id, message_id
                });
            }
            if (v[6][4] === 0x14) {
                const data = pb.decode("NotifyMsgBody", v[6].slice(7));
                if (data.optGeneralGrayTip) {
                    let user_id, operator_id, action, suffix;
                    for (let k in data.optGeneralGrayTip.msgTemplParam) {
                        const o = data.optGeneralGrayTip.msgTemplParam[k]
                        if (o.name === "action_str")
                            action = o.value;
                        if (o.name === "uin_str1")
                            operator_id = parseInt(o.value);
                        if (o.name === "uin_str2")
                            user_id = parseInt(o.value);
                        if (o.name === "suffix_str")
                            suffix = o.value;
                    }
                    if (!operator_id)
                        continue;
                    if (!user_id)
                        user_id = c.uin;
                    event.emit(c, "notice.group.poke", {
                        group_id, user_id, operator_id, action, suffix
                    });
                }
            }

            const o = v[6];
            let user_id, field, enable;
            if (o[4] === 0x06 && o[5] === 1) {
                field = "enable_guest", enable = o[10] > 0;
                user_id = o.readUInt32BE(6);
            }
            else if (o[4] === 0x0e && o[5] === 1) {
                field = "enable_anonymous", enable = o[10] === 0;
                user_id = o.readUInt32BE(6);
            }
            else if (o[4] === 0x0f) {
                if (o[12] === 1)
                    field = "enable_upload_album";
                else if (o[12] === 2)
                    field = "enable_upload_file";
                enable = o[8] === 0x0 || o[8] === 0x20;
                user_id = c.gl.get(group_id).owner_id;
            }
            else if (o[4] === 0x10) {
                const sub = pb.decode("Sub10", o.slice(7));
                if (sub.entry && sub.entry.text) {
                    let str = sub.entry.text;
                    user_id = str.includes("群主") ? c.gl.get(group_id).owner_id : -1;
                    if (str.includes("获得群主授予的")) {
                        user_id = toInt(sub.entry.uin);
                        str = str.substr(0, str.length - 2);
                        const title = str.substr(str.lastIndexOf("获得群主授予的") + 7);
                        str = str.substr(0, str.length - title.length - 7);
                        const nickname = str.substr(2);
                        try {
                            c.gml.get(group_id).get(user_id).title = title;
                            c.gml.get(group_id).get(user_id).title_expire_time = -1;
                        } catch(e) {}
                        event.emit(c, "notice.group.title", {
                            group_id, user_id,
                            nickname, title
                        });
                        continue;
                    } else if (str.includes("坦白说")) {
                        field = "enable_confess";
                        enable = str.includes("开启");
                    } else if (str.includes("临时会话")) {
                        field = "enable_temp_chat";
                        enable = str.includes("允许");
                    } else if (str.includes("新的群聊")) {
                        field = "enable_new_group";
                        enable = str.includes("允许");
                    }
                }
                if (o[6] === 0x22) {
                    if (o[o.length - 2] === 0x08)
                        field = "enable_show_honor";
                    if (o[o.length - 2] === 0x10)
                        field = "enable_show_level";
                    enable = o[o.length - 1] === 0;
                    user_id = -1;
                }
                if (o[6] === 0x26) {
                    // 改群分类 <Buffer 44 25 6e 9f 10 00 26 08 18 10 96 8a e3 fa 05 18 ff ff ff ff 0f 20 9f dd 95 a1 04 68 17 a8 01 f5 ef e8 b1 01 f2 01 06 18 8c 04 40 9a 4e>
                }
            } else {
                continue;
            }
            if (field && enable !== undefined) {
                const e = {
                    group_id, user_id
                };
                e[field] = enable;
                event.emit(c, "notice.group.setting", e);
            }
        }
    }
    c.write(outgoing.buildOnlinePushResponsePacket(parent[3], seq, rubbish, c));
}
async function decodeOnlinePushTransEvent(blob, c, seq) {
    const o = pb.decode("TransMsgInfo", blob);
    c.write(outgoing.buildOnlinePushResponsePacket(o.svrIp, seq, [], c));
    if (!c.sync_finished) return;
    const time = toInt(o.realMsgTime);
    const buf = o.msgData;
    const group_id = buf.readUInt32BE();
    if (o.msgType === 44) {
        if (buf[5] === 0 || buf[5] === 1) {
            const user_id = buf.readUInt32BE(6);
            const set = buf[10] > 0;
            try {
                (await c.getGroupMemberInfo(group_id, user_id)).data.role = (set ? "admin" : "member");
            } catch (e) {}
            event.emit(c, "notice.group.admin", {
                group_id, user_id, set, time
            });
        } else if (buf[5] === 0xFF) {
            const operator_id = buf.readUInt32BE(6);
            const user_id = buf.readUInt32BE(10);
            try {
                c.gl.get(group_id).owner_id = user_id;
                (await c.getGroupMemberInfo(group_id, operator_id)).data.role = "member";
                (await c.getGroupMemberInfo(group_id, user_id)).data.role = "owner";
            } catch (e) {}
            event.emit(c, "notice.group.transfer", {
                group_id, operator_id, user_id, time
            });
        }
    }
    if (o.msgType === 34) {
        const user_id = buf.readUInt32BE(5);
        let operator_id, dismiss = false;
        if (buf[9] === 0x82 || buf[9] === 0x2) {
            operator_id = user_id;
            try {
                c.gml.get(group_id).delete(user_id);
            } catch (e) {}
        } else {
            operator_id = buf.readUInt32BE(10);
            if (buf[9] === 0x01)
                dismiss = true;
            if (user_id === c.uin) {
                c.gl.delete(group_id);
                c.gml.delete(group_id);
                c.logger.info(`更新了群列表，删除了群：${group_id}`);
            } else {
                try {
                    c.gml.get(group_id).delete(user_id);
                } catch (e) {}
            }
        }
        try {
            c.gl.get(group_id).member_count--;
        } catch (e) {}
        event.emit(c, "notice.group.decrease", {
            group_id, user_id, operator_id, dismiss, time
        });
    }
}

//offline----------------------------------------------------------------------------------------------------

function decodeForceOfflineEvent(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    event.emit(c, "internal.kickoff", {
        type: "PushForceOffline",
        info: `[${parent[1]}]${parent[2]}`,
    });
}
function decodeReqMSFOfflineEvent(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    if (parent[3].includes("如非本人操作，则密码可能已泄露"))
        return;
    event.emit(c, "internal.kickoff", {
        type: "ReqMSFOffline",
        info: `[${parent[4]}]${parent[3]}`,
    });
}

//msg rsp----------------------------------------------------------------------------------------------------

function decodeSendMessageResponse(blob, c) {
    return pb.decode("PbSendMsgResp", blob);
}
function decodeDeleteMessageResponse(blob, c) {
    // console.log(pb.decode("PbDeleteMsgResp", blob))
}
function decodeRecallMessageResponse(blob, c) {
    //todo
}

//grp op rsp----------------------------------------------------------------------------------------------------

function decodeEditGroupCardResponse(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    return parent[3].length > 0;
}

/**
 * @returns {boolean}
 */
function decodeGroupAdminResponse(blob, c) {
    const o = pb.decode("OIDBSSOPkg", blob);
    return o.result === 0;
}

/**
 * @returns {boolean}
 */
function decodeSpecialTitleResponse(blob, c) {
    const o = pb.decode("OIDBSSOPkg", blob);
    return o.result === 0;
}

/**
 * @returns {boolean}
 */
function decodeGroupMngResponse(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    return parent[1] === 0;
}
/**
 * @returns {boolean}
 */
function decodeGroupKickResponse(blob, c) {
    const o = pb.decode("OIDBSSOPkg", blob);
    const body = pb.decode("D8A0RspBody", o.bodybuffer);
    return body.msgKickResult[0].optUint32Result === 0;
}
function decodeGroupBanResponse(blob, c) {
    //无法通过返回值知晓结果
}

//service----------------------------------------------------------------------------------------------------

function decodeImageStoreResponse(blob, c) {
    return pb.decode("D388RespBody", blob);
}
function decodeOffPicUpResponse(blob, c) {
    return pb.decode("OffPicUpRspBody", blob);
}
function decodePttUpResponse(blob, c) {
    return pb.decode("D388RespBody", blob);
}
function decodeMultiApplyUpResponse(blob, c) {
    return pb.decode("MultiRspBody", blob);
}
function decodeMultiApplyDownResponse(blob, c) {
    return pb.decode("MultiRspBody", blob);
}
function decodeGroupFileUrlResponse(blob, c) {
    return pb.decode("D6D6RspBody", pb.decode("OIDBSSOPkg", blob).bodybuffer);
}

//individual rsp----------------------------------------------------------------------------------------------------

function decodeSendLikeResponse(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    return jce.decode(parent[0])[3] === 0;
}
function decodeAddSettingResponse(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    if (parent[4]) return false;
    return parent[2];
}
function decodeAddFriendResponse(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    return parent[6] === 0;
}
function decodeDelFriendResponse(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    return parent[2] === 0;
}
function decodeInviteResponse(blob, c) {
    return pb.decode("OIDBSSOPkg", blob).bodybuffer.length > 6;
}

function decodeSetProfileResponse(blob, c) {
    const o = pb.decode("OIDBSSOPkg", blob);
    return o.result === 0 || o.result === 34;
}

function decodeSetSignResponse(blob, c) {
    const o = pb.decode("SignAuthRspPkg", blob);
    return o.result === 0;
}

//----------------------------------------------------------------------------------------------------

const CMD = outgoing.CMD;
const decoders = new Map([
    [CMD.LOGIN,             decodeLoginResponse],
    [CMD.REGISTER,          decodeClientRegisterResponse],
    [CMD.CHANGE_STATUS,     decodeClientRegisterResponse],

    [CMD.GET_MSG,           decodeMessageSvcResponse],
    [CMD.SEND_MSG,          decodeSendMessageResponse],
    [CMD.DELETE_MSG,        decodeDeleteMessageResponse],
    [CMD.RECALL,            decodeRecallMessageResponse],

    [CMD.FRIEND_LIST,       decodeFriendListResponse],
    [CMD.GROUP_LIST,        decodeGroupListResponse],
    [CMD.MEMBER_LIST,       decodeGroupMemberListResponse],
    [CMD.GROUP_INFO,        decodeGroupInfoResponse],
    [CMD.GROUP_MEMBER,      decodeGroupMemberInfoResponse],
    [CMD.STRANGER_INFO,     decodeStrangerInfoResponse],

    [CMD.SET_SIGN,          decodeSetSignResponse],
    [CMD.SET_PROFILE,       decodeSetProfileResponse],
    [CMD.SEND_LIKE,         decodeSendLikeResponse],
    [CMD.ADD_SETTING,       decodeAddSettingResponse],
    [CMD.ADD_FRIEND,        decodeAddFriendResponse],
    [CMD.DEL_FRIEND,        decodeDelFriendResponse],
    [CMD.GROUP_INVITE,      decodeInviteResponse],

    [CMD.FRIEND_REQ,        decodeNewFriendResponse],
    [CMD.GROUP_REQ,         decodeNewGroupResponse],
    [CMD.FRIEND_REQ_ACT,    decodeSystemActionResponse],
    [CMD.GROUP_REQ_ACT,     decodeSystemActionResponse],
    
    [CMD.GROUP_MSG,         decodeGroupMessageEvent],
    [CMD.DISCUSS_MSG,       decodeDiscussMessageEvent],
    [CMD.PUSH_NOTIFY,       decodePushNotifyEvent],
    [CMD.ONLINE_PUSH,       decodeOnlinePushEvent],
    [CMD.ONLINE_PB_PUSH,    decodeOnlinePushTransEvent],

    [CMD.GROUP_CARD,        decodeEditGroupCardResponse],
    [CMD.GROUP_MNG,         decodeGroupMngResponse],
    [CMD.GROUP_KICK,        decodeGroupKickResponse],
    [CMD.GROUP_BAN,         decodeGroupBanResponse],
    [CMD.GROUP_ADMIN,       decodeGroupAdminResponse],
    [CMD.GROUP_TITLE,       decodeSpecialTitleResponse],

    [CMD.PUSH_REQ,          decodePushReqEvent],
    [CMD.OFFLINE,           decodeForceOfflineEvent],
    [CMD.MFS_OFFLINE,       decodeReqMSFOfflineEvent],

    [CMD.IMG_STORE,         decodeImageStoreResponse],
    [CMD.OFF_PIC_UP,        decodeOffPicUpResponse],
    [CMD.PTT_UP,            decodePttUpResponse],
    [CMD.MULTI_UP,          decodeMultiApplyUpResponse],
    [CMD.MULTI_DOWN,        decodeMultiApplyDownResponse],
    [CMD.GROUP_FILE,        decodeGroupFileUrlResponse]
]);

//----------------------------------------------------------------------------------------------

/**
 * @param {Buffer} packet 
 * @param {Client}
 * @returns {void}
 */
module.exports = function parseIncomingPacket(packet, c) {
    const stream = Readable.from(packet, {objectMode:false});
    const flag1 = stream.read(4).readInt32BE();
    if (flag1 !== 0x0A && flag1 !== 0x0B)
        throw new Error("decrypt failed");
    const flag2 = stream.read(1).readUInt8();
    const flag3 = stream.read(1).readUInt8();
    if (flag3 !== 0)
        throw new Error("unknown flag");
    stream.read(stream.read(4).readInt32BE() - 4);
    let decrypted = stream.read();
    switch (flag2) {
        case 0:
            break;
        case 1:
            decrypted = tea.decrypt(decrypted, c.sign_info.d2key);
            break;
        case 2:
            decrypted = tea.decrypt(decrypted, Buffer.alloc(16));
            break;
        default:
            decrypted = Buffer.alloc(0)
            break;
    }
    if (!decrypted.length)
        throw new Error("decrypt failed");
 
    const sso = parseSSO(decrypted);
    c.logger.trace(`recv:${sso.command_name} seq:${sso.seq_id}`);

    let ret;
    if (flag2 === 2)
        sso.payload = parseOICQ(sso.payload);
    if (decoders.has(sso.command_name))
        ret = decoders.get(sso.command_name)(sso.payload, c, sso.seq_id);
    else
        unknownDebug(sso.payload);
    if (c.handlers.has(sso.seq_id))
        c.handlers.get(sso.seq_id)(ret);
};

function unknownDebug(blob) {
    // const nested = jce.decodeWrapper(blob);
    // const parent = jce.decode(nested);
    // common.log(parent)
    // common.log(blob.toString("hex").replace(/(.)(.)/g, '$1$2 '));
}
