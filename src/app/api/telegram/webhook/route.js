"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.POST = POST;
var server_1 = require("next/server");
var db_1 = require("@/lib/db");
var telegram_1 = require("@/lib/telegram");
var telegram_agent_1 = require("@/lib/telegram-agent");
var guardian_runtime_1 = require("@/lib/guardian-runtime");
// POST: Telegram Webhook Entrypoint
function POST(request) {
    return __awaiter(this, void 0, void 0, function () {
        var body, authorizedChatId, _a, id, data, message, chatId, chatId, error_1;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    _d.trys.push([0, 8, , 9]);
                    return [4 /*yield*/, request.json()];
                case 1:
                    body = _d.sent();
                    authorizedChatId = (0, db_1.getSetting)('telegram_chat_id');
                    if (!authorizedChatId) {
                        console.warn('[Telegram Webhook] No configured chat ID.');
                        return [2 /*return*/, server_1.NextResponse.json({ ok: true })];
                    }
                    if (!body.callback_query) return [3 /*break*/, 3];
                    _a = body.callback_query, id = _a.id, data = _a.data, message = _a.message;
                    chatId = String((_b = message === null || message === void 0 ? void 0 : message.chat) === null || _b === void 0 ? void 0 : _b.id);
                    if (chatId !== authorizedChatId)
                        return [2 /*return*/, server_1.NextResponse.json({ ok: true })];
                    return [4 /*yield*/, handleCallbackQuery(id, data)];
                case 2:
                    _d.sent();
                    return [2 /*return*/, server_1.NextResponse.json({ ok: true })];
                case 3:
                    if (!((_c = body.message) === null || _c === void 0 ? void 0 : _c.text)) return [3 /*break*/, 7];
                    chatId = String(body.message.chat.id);
                    if (!(chatId !== authorizedChatId)) return [3 /*break*/, 5];
                    return [4 /*yield*/, (0, telegram_1.sendTelegram)('Sorry, I am a private LifeOS assistant.', 'HTML')];
                case 4:
                    _d.sent();
                    return [2 /*return*/, server_1.NextResponse.json({ ok: true })];
                case 5: return [4 /*yield*/, (0, telegram_agent_1.handleTelegramCommand)(body.message.text)];
                case 6:
                    _d.sent();
                    return [2 /*return*/, server_1.NextResponse.json({ ok: true })];
                case 7: return [2 /*return*/, server_1.NextResponse.json({ ok: true })];
                case 8:
                    error_1 = _d.sent();
                    console.error('[Telegram Webhook] Error:', error_1);
                    return [2 /*return*/, server_1.NextResponse.json({ ok: false, error: 'Internal error' }, { status: 500 })];
                case 9: return [2 /*return*/];
            }
        });
    });
}
// ─── Callback Query Router ────────────────────────────────────────────────────
function handleCallbackQuery(callbackId, actionData) {
    return __awaiter(this, void 0, void 0, function () {
        var colonIdx, type, rest, tok;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    colonIdx = actionData.indexOf(':');
                    type = actionData.slice(0, colonIdx);
                    rest = actionData.slice(colonIdx + 1);
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, , 14, 15]);
                    if (!(type === 'action')) return [3 /*break*/, 3];
                    return [4 /*yield*/, handleActionCallback(rest)];
                case 2:
                    _a.sent();
                    return [3 /*break*/, 13];
                case 3:
                    if (!(type === 'review')) return [3 /*break*/, 5];
                    return [4 /*yield*/, handleReviewCallback(rest)];
                case 4:
                    _a.sent();
                    return [3 /*break*/, 13];
                case 5:
                    if (!(type === 'task')) return [3 /*break*/, 7];
                    return [4 /*yield*/, handleTaskCallback(rest)];
                case 6:
                    _a.sent();
                    return [3 /*break*/, 13];
                case 7:
                    if (!(type === 'feedback')) return [3 /*break*/, 9];
                    return [4 /*yield*/, handleFeedbackCallback(rest)];
                case 8:
                    _a.sent();
                    return [3 /*break*/, 13];
                case 9:
                    if (!(type === 'session')) return [3 /*break*/, 11];
                    return [4 /*yield*/, handleSessionCallback(rest)];
                case 10:
                    _a.sent();
                    return [3 /*break*/, 13];
                case 11: return [4 /*yield*/, (0, telegram_1.sendTelegram)("Unknown callback: ".concat(actionData), '')];
                case 12:
                    _a.sent();
                    _a.label = 13;
                case 13: return [3 /*break*/, 15];
                case 14:
                    tok = process.env.TELEGRAM_BOT_TOKEN || (0, db_1.getSetting)('telegram_bot_token');
                    if (tok) {
                        fetch("https://api.telegram.org/bot".concat(tok, "/answerCallbackQuery"), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ callback_query_id: callbackId }),
                        }).catch(console.error);
                    }
                    return [7 /*endfinally*/];
                case 15: return [2 /*return*/];
            }
        });
    });
}
// ─── action: callbacks ────────────────────────────────────────────────────────
function handleActionCallback(payload) {
    return __awaiter(this, void 0, void 0, function () {
        var session, _a, _b, loadActiveWeeklyPlan, generateWeeklyPlan, saveWeeklyPlan, plan, db, reviews, db, today, sessionsRow, tasksRow, habitsRow, scoreEmoji, text, db, lastSession;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    session = (0, guardian_runtime_1.getActiveGuardianSession)();
                    _a = payload;
                    switch (_a) {
                        case 'status': return [3 /*break*/, 1];
                        case 'new_session': return [3 /*break*/, 3];
                        case 'end_session': return [3 /*break*/, 5];
                        case 'tasks': return [3 /*break*/, 9];
                        case 'habits': return [3 /*break*/, 11];
                        case 'standup': return [3 /*break*/, 13];
                        case 'weekly_plan': return [3 /*break*/, 15];
                        case 'goals': return [3 /*break*/, 18];
                        case 'review': return [3 /*break*/, 20];
                        case 'report': return [3 /*break*/, 24];
                        case 'calibration': return [3 /*break*/, 26];
                        case 'feedback_prompt': return [3 /*break*/, 28];
                        case 'override_info': return [3 /*break*/, 33];
                        case 'dismiss_alert': return [3 /*break*/, 35];
                        case 'cancel_softwatch': return [3 /*break*/, 37];
                        case 'snooze': return [3 /*break*/, 39];
                    }
                    return [3 /*break*/, 41];
                case 1: return [4 /*yield*/, (0, telegram_agent_1.executeAction)('STATUS', '', {}, session)];
                case 2:
                    _c.sent();
                    return [3 /*break*/, 43];
                case 3: return [4 /*yield*/, (0, telegram_1.sendTelegram)("\uD83C\uDFAF <b>Start a Session</b>\n\nReply with what to focus on, e.g.:\n<i>\"Lock in on React for 60m\"</i>", 'HTML')];
                case 4:
                    _c.sent();
                    return [3 /*break*/, 43];
                case 5:
                    if (!!session) return [3 /*break*/, 7];
                    return [4 /*yield*/, (0, telegram_1.sendTelegram)('💤 No active session.', 'HTML', telegram_1.FULL_MENU_KEYBOARD)];
                case 6:
                    _c.sent();
                    return [3 /*break*/, 43];
                case 7:
                    (0, guardian_runtime_1.endGuardianSession)(session.sessionId);
                    (0, db_1.setSetting)('telegram_awaiting_feedback_session', session.sessionId);
                    return [4 /*yield*/, (0, telegram_1.sendTelegram)("\uD83C\uDFC1 <b>Session ended.</b>\n\n\uD83D\uDCAC How did it feel? Reply with a short reflection to calibrate your model.\n<i>(or send anything else to skip)</i>", 'HTML')];
                case 8:
                    _c.sent();
                    return [3 /*break*/, 43];
                case 9: return [4 /*yield*/, (0, telegram_agent_1.executeAction)('SHOW_TASKS', '', {})];
                case 10:
                    _c.sent();
                    return [3 /*break*/, 43];
                case 11: return [4 /*yield*/, (0, telegram_agent_1.executeAction)('SHOW_HABITS', '', {})];
                case 12:
                    _c.sent();
                    return [3 /*break*/, 43];
                case 13: return [4 /*yield*/, (0, telegram_agent_1.executeAction)('STANDUP', '', {})];
                case 14:
                    _c.sent();
                    return [3 /*break*/, 43];
                case 15: return [4 /*yield*/, Promise.resolve().then(function () { return require('@/lib/weekly-planner'); })];
                case 16:
                    _b = _c.sent(), loadActiveWeeklyPlan = _b.loadActiveWeeklyPlan, generateWeeklyPlan = _b.generateWeeklyPlan, saveWeeklyPlan = _b.saveWeeklyPlan;
                    plan = loadActiveWeeklyPlan();
                    if (!plan) {
                        plan = generateWeeklyPlan();
                        saveWeeklyPlan(plan);
                    }
                    return [4 /*yield*/, (0, telegram_1.sendTelegram)((0, telegram_1.formatWeeklyPlanSummary)(plan), 'HTML', telegram_1.FULL_MENU_KEYBOARD)];
                case 17:
                    _c.sent();
                    return [3 /*break*/, 43];
                case 18: return [4 /*yield*/, (0, telegram_agent_1.executeAction)('GOAL_STATUS', '', {})];
                case 19:
                    _c.sent();
                    return [3 /*break*/, 43];
                case 20:
                    db = (0, db_1.getDb)();
                    reviews = db.prepare("\n        SELECT sc.id, sc.session_id, sc.task_id,\n               t.title as task_title,\n               gss.target_title, gss.elapsed_minutes, gss.final_focus_score AS focus_score, gss.mood\n        FROM session_completions sc\n        LEFT JOIN tasks t ON t.id = sc.task_id\n        LEFT JOIN guardian_session_summaries gss ON gss.session_id = sc.session_id\n        WHERE sc.status = 'pending'\n        ORDER BY sc.created_at DESC LIMIT 5\n      ").all();
                    if (!(reviews.length === 0)) return [3 /*break*/, 22];
                    return [4 /*yield*/, (0, telegram_1.sendTelegram)("\uD83D\uDCDD <b>Review Queue</b>\n\nAll caught up! \uD83C\uDF89", 'HTML', telegram_1.FULL_MENU_KEYBOARD)];
                case 21:
                    _c.sent();
                    return [3 /*break*/, 43];
                case 22: return [4 /*yield*/, (0, telegram_1.sendTelegram)((0, telegram_1.formatPendingReviews)(reviews), 'HTML', (0, telegram_1.buildReviewKeyboard)(reviews[0].id))];
                case 23:
                    _c.sent();
                    return [3 /*break*/, 43];
                case 24:
                    db = (0, db_1.getDb)();
                    today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
                    sessionsRow = db.prepare("\n        SELECT COUNT(*) as count,\n               COALESCE(AVG(final_focus_score), 0) as avg_focus,\n               COALESCE(SUM(elapsed_minutes), 0) as total_minutes\n        FROM guardian_session_summaries\n        WHERE date(completed_at, 'localtime') = ?\n      ").get(today);
                    tasksRow = db.prepare("\n        SELECT COUNT(*) as total,\n               SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done\n        FROM tasks WHERE status IN ('done', 'today', 'doing', 'this_week')\n      ").get();
                    habitsRow = db.prepare("\n        SELECT COUNT(*) as total,\n               SUM(CASE WHEN hc.completed = 1 THEN 1 ELSE 0 END) as done\n        FROM habits h\n        LEFT JOIN habit_checkins hc ON hc.habit_id = h.id AND hc.date = ?\n        WHERE h.archived = 0\n      ").get(today);
                    scoreEmoji = sessionsRow.avg_focus >= 85 ? '🔥' : sessionsRow.avg_focus >= 70 ? '✅' : sessionsRow.avg_focus >= 50 ? '🟡' : '🔴';
                    text = [
                        "\uD83D\uDCCA <b>Daily Report \u2014 ".concat(today, "</b>"),
                        "",
                        "".concat(scoreEmoji, " <b>Avg Focus:</b> ").concat(Math.round(sessionsRow.avg_focus), "/100"),
                        "\uD83D\uDEE1\uFE0F <b>Sessions:</b> ".concat(sessionsRow.count, " (").concat(sessionsRow.total_minutes, "m total)"),
                        "\uD83D\uDCCB <b>Tasks:</b> ".concat(tasksRow.done, "/").concat(tasksRow.total, " done"),
                        "\uD83D\uDCAA <b>Habits:</b> ".concat(habitsRow.done, "/").concat(habitsRow.total, " checked"),
                    ].join('\n');
                    return [4 /*yield*/, (0, telegram_1.sendTelegram)(text, 'HTML', telegram_1.FULL_MENU_KEYBOARD)];
                case 25:
                    _c.sent();
                    return [3 /*break*/, 43];
                case 26: return [4 /*yield*/, (0, telegram_agent_1.executeAction)('CALIBRATION', '', {})];
                case 27:
                    _c.sent();
                    return [3 /*break*/, 43];
                case 28:
                    db = (0, db_1.getDb)();
                    lastSession = db.prepare("\n        SELECT session_id FROM guardian_session_summaries ORDER BY completed_at DESC LIMIT 1\n      ").get();
                    if (!lastSession) return [3 /*break*/, 30];
                    (0, db_1.setSetting)('telegram_awaiting_feedback_session', lastSession.session_id);
                    return [4 /*yield*/, (0, telegram_1.sendTelegram)("\uD83D\uDCAC <b>Session Feedback</b>\n\nHow did your last session feel?\n<i>Energy accurate? Distractions? Length?</i>", 'HTML')];
                case 29:
                    _c.sent();
                    return [3 /*break*/, 32];
                case 30: return [4 /*yield*/, (0, telegram_1.sendTelegram)('No recent session to give feedback on.', '', telegram_1.FULL_MENU_KEYBOARD)];
                case 31:
                    _c.sent();
                    _c.label = 32;
                case 32: return [3 /*break*/, 43];
                case 33: return [4 /*yield*/, (0, telegram_1.sendTelegram)("\uD83D\uDEAB <b>Override Request</b>\n\nTo request an override, reply:\n<i>\"Override [url or site] because [reason]\"</i>\n\nOverrides are time-limited and AI-adjudicated.", 'HTML')];
                case 34:
                    _c.sent();
                    return [3 /*break*/, 43];
                case 35: return [4 /*yield*/, (0, telegram_1.sendTelegram)('✅ Alert dismissed.', '', telegram_1.FULL_MENU_KEYBOARD)];
                case 36:
                    _c.sent();
                    return [3 /*break*/, 43];
                case 37: return [4 /*yield*/, (0, telegram_1.sendTelegram)('❌ Soft watch cancelled.', '', telegram_1.FULL_MENU_KEYBOARD)];
                case 38:
                    _c.sent();
                    return [3 /*break*/, 43];
                case 39: return [4 /*yield*/, (0, telegram_1.sendTelegram)('⏰ Snoozed 15 minutes.', '', telegram_1.FULL_MENU_KEYBOARD)];
                case 40:
                    _c.sent();
                    return [3 /*break*/, 43];
                case 41: return [4 /*yield*/, (0, telegram_1.sendTelegram)("Unknown action: ".concat(payload), '', telegram_1.FULL_MENU_KEYBOARD)];
                case 42:
                    _c.sent();
                    _c.label = 43;
                case 43: return [2 /*return*/];
            }
        });
    });
}
// ─── review: callbacks ────────────────────────────────────────────────────────
function handleReviewCallback(rest) {
    return __awaiter(this, void 0, void 0, function () {
        var colonIdx, subAction, id, db, row, msg, next;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    colonIdx = rest.indexOf(':');
                    subAction = rest.slice(0, colonIdx);
                    id = parseInt(rest.slice(colonIdx + 1), 10);
                    if (!isNaN(id)) return [3 /*break*/, 2];
                    return [4 /*yield*/, (0, telegram_1.sendTelegram)('Invalid review ID.', '')];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
                case 2:
                    db = (0, db_1.getDb)();
                    row = db.prepare("SELECT id, task_id FROM session_completions WHERE id = ?").get(id);
                    if (!!row) return [3 /*break*/, 4];
                    return [4 /*yield*/, (0, telegram_1.sendTelegram)('Review not found.', '', telegram_1.FULL_MENU_KEYBOARD)];
                case 3:
                    _a.sent();
                    return [2 /*return*/];
                case 4:
                    msg = '';
                    if (subAction === 'done') {
                        db.prepare("UPDATE session_completions SET status = 'done', actioned_at = datetime('now') WHERE id = ?").run(id);
                        if (row.task_id) {
                            db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(row.task_id);
                        }
                        msg = '✅ Marked as done!';
                    }
                    else if (subAction === 'blocked') {
                        db.prepare("UPDATE session_completions SET status = 'blocked', actioned_at = datetime('now') WHERE id = ?").run(id);
                        if (row.task_id) {
                            db.prepare("UPDATE tasks SET blocked_since = date('now', 'localtime') WHERE id = ?").run(row.task_id);
                        }
                        msg = '🚫 Marked as blocked.';
                    }
                    else if (subAction === 'skip') {
                        db.prepare("UPDATE session_completions SET status = 'skipped', actioned_at = datetime('now') WHERE id = ?").run(id);
                        msg = '⏭ Skipped.';
                    }
                    next = db.prepare("\n    SELECT sc.id, sc.session_id, sc.task_id,\n           t.title as task_title,\n           gss.target_title, gss.elapsed_minutes, gss.final_focus_score AS focus_score, gss.mood\n    FROM session_completions sc\n    LEFT JOIN tasks t ON t.id = sc.task_id\n    LEFT JOIN guardian_session_summaries gss ON gss.session_id = sc.session_id\n    WHERE sc.status = 'pending' AND sc.id != ?\n    ORDER BY sc.created_at DESC LIMIT 1\n  ").get(id);
                    if (!next) return [3 /*break*/, 6];
                    return [4 /*yield*/, (0, telegram_1.sendTelegram)("".concat(msg, "\n\n") + (0, telegram_1.formatPendingReviews)([next]), 'HTML', (0, telegram_1.buildReviewKeyboard)(next.id))];
                case 5:
                    _a.sent();
                    return [3 /*break*/, 8];
                case 6: return [4 /*yield*/, (0, telegram_1.sendTelegram)("".concat(msg, " All reviews complete! \uD83C\uDF89"), 'HTML', telegram_1.FULL_MENU_KEYBOARD)];
                case 7:
                    _a.sent();
                    _a.label = 8;
                case 8: return [2 /*return*/];
            }
        });
    });
}
// ─── task: callbacks ──────────────────────────────────────────────────────────
function handleTaskCallback(rest) {
    return __awaiter(this, void 0, void 0, function () {
        var colonIdx, subAction, id, session, db, task, duration;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    colonIdx = rest.indexOf(':');
                    subAction = rest.slice(0, colonIdx);
                    id = parseInt(rest.slice(colonIdx + 1), 10);
                    if (!(subAction === 'start' && !isNaN(id))) return [3 /*break*/, 6];
                    session = (0, guardian_runtime_1.getActiveGuardianSession)();
                    if (!session) return [3 /*break*/, 2];
                    return [4 /*yield*/, (0, telegram_1.sendTelegram)("\u26A0\uFE0F Already in session: <b>".concat(session.targetTitle, "</b>. End it first."), 'HTML', telegram_1.SESSION_START_KEYBOARD)];
                case 1:
                    _b.sent();
                    return [2 /*return*/];
                case 2:
                    db = (0, db_1.getDb)();
                    task = db.prepare("SELECT title, estimated_minutes FROM tasks WHERE id = ?").get(id);
                    if (!!task) return [3 /*break*/, 4];
                    return [4 /*yield*/, (0, telegram_1.sendTelegram)('Task not found.', '', telegram_1.FULL_MENU_KEYBOARD)];
                case 3:
                    _b.sent();
                    return [2 /*return*/];
                case 4:
                    duration = (_a = task.estimated_minutes) !== null && _a !== void 0 ? _a : 60;
                    (0, guardian_runtime_1.startGuardianSession)({ topic: task.title, durationMinutes: duration, source: 'api' });
                    return [4 /*yield*/, (0, telegram_1.sendTelegram)("\uD83D\uDEE1\uFE0F <b>Session started!</b>\n\uD83D\uDCDA ".concat(task.title, "\n\u23F1\uFE0F ").concat(duration, " min"), 'HTML', telegram_1.SESSION_START_KEYBOARD)];
                case 5:
                    _b.sent();
                    _b.label = 6;
                case 6: return [2 /*return*/];
            }
        });
    });
}
function handleSessionCallback(payload) {
    return __awaiter(this, void 0, void 0, function () {
        var duration, syntheticCommand;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    duration = parseInt(payload, 10);
                    if (!isNaN(duration)) return [3 /*break*/, 2];
                    return [4 /*yield*/, (0, telegram_1.sendTelegram)('Invalid session duration.', 'HTML')];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
                case 2:
                    syntheticCommand = "Lock in for ".concat(duration, "m");
                    return [4 /*yield*/, (0, telegram_agent_1.handleTelegramCommand)(syntheticCommand)];
                case 3:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
// ─── feedback: callbacks ──────────────────────────────────────────────────────
function handleFeedbackCallback(payload) {
    return __awaiter(this, void 0, void 0, function () {
        var db, lastSession;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!(payload === 'accurate')) return [3 /*break*/, 2];
                    return [4 /*yield*/, (0, telegram_1.sendTelegram)('✅ Noted — factored into calibration.', '', telegram_1.FULL_MENU_KEYBOARD)];
                case 1:
                    _a.sent();
                    return [3 /*break*/, 4];
                case 2:
                    if (!(payload === 'add_note')) return [3 /*break*/, 4];
                    db = (0, db_1.getDb)();
                    lastSession = db.prepare("SELECT session_id FROM guardian_session_summaries ORDER BY completed_at DESC LIMIT 1").get();
                    if (lastSession) {
                        (0, db_1.setSetting)('telegram_awaiting_feedback_session', lastSession.session_id);
                    }
                    return [4 /*yield*/, (0, telegram_1.sendTelegram)('💬 Reply with your reflection for this session.', '')];
                case 3:
                    _a.sent();
                    _a.label = 4;
                case 4: return [2 /*return*/];
            }
        });
    });
}
