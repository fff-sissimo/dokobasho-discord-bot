const MESSAGES = {
    errors: {
        reminderNotConfigured: 'リマインダー機能は現在設定されていません。',
        generic: 'エラーが発生しました。詳細はログを確認してください。',
        invalidTimezone: '❌ タイムゾーンの指定が正しくありません。例: Asia/Tokyo / JST / +09:00',
        invalidTime: '❌ 時刻の指定が正しくありません。「明日の10時」や「2026-01-11 15:00」のように指定してください。',
    },
    reminders: {
        notification: (content) => `**リマインダー:** ${content}`,
    },
    responses: {
        adminRequiredForCreate: 'サーバー全体のリマインダーを作成するには、管理者権限が必要です。',
        adminRequiredForDelete: 'サーバー全体のリマインダーを削除するには、管理者権限が必要です。',
        channelRequiredForServerScope: 'サーバー全体のリマインダーは通知先チャンネルの指定が必要です。',
        created: (key, displayDate) => `✅ リマインダーを登録しました！\n**キー:** ${key}\n**次回通知:** ${displayDate}`,
        getDisabled: 'この機能は現在停止中です。`/remind list` で一覧を確認してください。',
        notFound: '該当するリマインダーは見つかりませんでした。',
        listEmpty: '登録されているリマインダーはありません。',
        listItem: (key, contentPreview, displayDate) => `- \`${key}\`: ${contentPreview}... (通知: ${displayDate})`,
        listHeader: (scope, total, displayed, listContent) => `**リマインダー一覧 (${scope}) - ${total}件中${displayed}件表示**\n${listContent}`,
        alreadyDeleted: 'このリマインダーは既に削除されているようです。',
        deleteConfirmLabel: 'はい、削除します',
        deleteConfirm: (key) => `本当にリマインダー「${key}」を削除しますか？この操作は取り消せません。`,
        deleteSuccess: (key) => `✅ リマインダー「${key}」を削除しました。`,
    },
    commands: {
        remind: {
            description: 'リマインダーを管理します。',
            add: {
                description: '新しいリマインダーを登録します (キーは自動生成: 8文字)。',
                options: {
                    time: '通知時刻 (例: 「明日の15時」「3日後 10:00」)',
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
                description: 'リマインダーの一覧を表示します。',
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
                description: 'リマインダーを削除します。',
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
