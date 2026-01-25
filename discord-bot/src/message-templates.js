const MESSAGES = {
    errors: {
        reminderNotConfigured: 'リマインダー機能は今は使えないみたいだよ。',
        generic: 'エラーが起きたよ。ログを見てね。',
        keyGenerationFailed: 'キーがうまく作れなかったよ。もう一回試してね。',
        invalidTimezone: '❌ タイムゾーンの指定が正しくないよ。例: Asia/Tokyo / JST / +09:00',
        invalidTime: '❌ 時刻の指定が正しくないよ。「明日の10時」や「2026-01-11 15:00」みたいに書いてね。',
    },
    reminders: {
        notification: (content) => `やっほ、リマインダーだよ！\n\n**内容:**\n ${content}`,
    },
    responses: {
        adminRequiredForCreate: 'サーバー全体のリマインダーは管理者だけだよ。',
        adminRequiredForDelete: 'サーバー全体のリマインダー削除は管理者だけだよ。',
        channelRequiredForServerScope: 'サーバー全体なら通知チャンネルを選んでね。',
        created: (key, displayDate) => `✅ リマインダーを登録したよ！\n**キー:** ${key}\n**次回通知:** ${displayDate}`,
        getDisabled: 'この機能は止めてあるよ。`/remind list` で確認してね。',
        notFound: '該当するリマインダーが見つからないよ。',
        listEmpty: '登録されているリマインダーはないよ。',
        listItem: (key, contentPreview, displayDate) => `- \`${key}\`: ${contentPreview}... (通知: ${displayDate})`,
        listHeader: (scope, total, displayed, listContent) => `**リマインダー一覧 (${scope}) - ${total}件中${displayed}件表示だよ**\n${listContent}`,
        alreadyDeleted: 'このリマインダーはもう消えてるみたいだよ。',
        deleteConfirmLabel: '削除する',
        deleteConfirm: (key) => `本当にリマインダー「${key}」を削除する？一度消したら戻せないよ。`,
        deleteSuccess: (key) => `✅ リマインダー「${key}」を削除したよ。`,
    },
    commands: {
        remind: {
            description: 'リマインダーを管理するよ。',
            add: {
                description: '新しいリマインダーを登録するよ (キーは自動生成: 8文字)。',
                options: {
                    time: '通知時刻 (例: 「2026-01-15 12:00」「10分後」)',
                    content: 'リマインド内容 (1-2000文字)',
                    scope: '公開範囲 (デフォルト: user)',
                    channel: '通知先チャンネル (scope=server の場合は必須)',
                    visibility: '応答の可視性 (デフォルト: ephemeral)',
                    recurring: '繰り返しの設定 (デフォルト: off)',
                    timezone: '時刻の解釈に使うタイムゾーン (例: Asia/Tokyo)',
                },
                choices: {
                    scope: {
                        user: '自分のみ (User)',
                        channel: 'このチャンネル (Channel)',
                        server: 'サーバー全体 (Server)',
                    },
                    visibility: {
                        ephemeral: '自分のみに表示 (Ephemeral)',
                        public: '全員に表示 (Public)',
                    },
                    recurring: {
                        off: 'しない (Off)',
                        daily: '毎日 (Daily)',
                        weekly: '毎週 (Weekly)',
                        monthly: '毎月 (Monthly)',
                    },
                },
            },
            list: {
                description: 'リマインダーの一覧を見るよ。',
                options: {
                    scope: '一覧表示する公開範囲',
                    query: 'キーまたは内容で検索します',
                    limit: '表示件数 (デフォルト: 50)',
                },
                choices: {
                    scope: {
                        user: '自分のみ (User)',
                        channel: 'このチャンネル (Channel)',
                        server: 'サーバー全体 (Server)',
                    },
                },
            },
            delete: {
                description: 'リマインダーを削除するよ。',
                options: {
                    key: '削除するリマインダーのキー',
                    scope: '公開範囲',
                    confirm: '確認なしで削除を実行しますか？ (デフォルト: false)',
                },
                choices: {
                    scope: {
                        user: '自分のみ (User)',
                        channel: 'このチャンネル (Channel)',
                        server: 'サーバー全体 (Server)',
                    },
                },
            },
        },
    },
};

module.exports = { MESSAGES };
