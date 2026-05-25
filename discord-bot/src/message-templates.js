const MESSAGES = {
    errors: {
        reminderNotConfigured: 'リマインダー機能は今は使えないみたいだよ。',
        fairyDisabled: 'Fairy機能は現在停止中だよ。',
        fairyNotConfigured: 'Fairy機能の接続先が未設定だよ。管理者に確認してね。',
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
        deleteConfirmLabel: 'うん、削除する',
        deleteConfirm: (key) => `本当にリマインダー「${key}」を削除する？一度消したら戻せないよ。`,
        deleteSuccess: (key) => `✅ リマインダー「${key}」を削除したよ。`,
    },
    imageGeneration: {
        confirmation: ({ purpose, summary }) => {
            const parts = ['画像を生成しますか？'];
            if (purpose) parts.push(`用途: ${purpose}`);
            const safeSummary = String(summary || '').replace(/\s+/g, ' ').trim().slice(0, 60);
            if (safeSummary) parts.push(`内容: ${safeSummary}`);
            return parts.join('\n');
        },
        accepted: '画像生成を受け付けました。少し待ってください。',
        queued: (position) => `画像生成を受け付けました。現在${position}番目です。`,
        rateLimited: (timestamp) => `画像生成の上限に達しました。次は ${timestamp} 以降に使えます。`,
        completed: '完了しました。',
        cancelled: 'キャンセルしました。',
        expired: '期限切れです。',
        buttons: {
            generate: '生成する',
            cancel: 'キャンセル',
        },
        errors: {
            invalid_request: '画像生成の依頼内容を読み取れませんでした。内容を少し具体的にして再試行してください。',
            auth_failed: '画像生成の設定に問題があります。管理者に確認してください。',
            credential_error: '画像生成の設定に問題があります。管理者に確認してください。',
            rate_limited: '画像生成の上限に達しました。少し時間を置いて再試行してください。',
            queue_full: '画像生成が混み合っています。少し時間を置いて再試行してください。',
            upstream_unavailable: '画像生成が混み合っています。少し時間を置いて再試行してください。',
            timeout: '画像生成が混み合っています。少し時間を置いて再試行してください。',
            quota_exceeded: '画像生成の設定に問題があります。管理者に確認してください。',
            model_unavailable: '画像生成の設定に問題があります。管理者に確認してください。',
            forbidden: 'この操作は依頼者本人だけができます。',
            not_confirming: 'この画像生成リクエストは現在確認できません。',
            expired: 'この画像生成リクエストは期限切れです。',
            not_found: 'この画像生成リクエストは見つかりませんでした。',
            not_cancellable: 'この画像生成リクエストはキャンセルできません。',
            actor_disabled: '画像生成はこのサーバーまたはユーザーでは現在停止されています。',
            channel_not_allowed: 'このチャンネルでは画像生成を使えません。',
            disabled: '画像生成は現在停止中です。',
            unknown: '画像生成に失敗しました。少し時間を置いて再試行してください。',
        },
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
        fairy: {
            description: '依頼内容を受け取り、処理の進捗を返すよ。',
            options: {
                request: '依頼内容（省略可）',
            },
        },
        image: {
            description: '画像を生成します。',
            options: {
                prompt: '生成したい画像の内容',
                purpose: '用途',
                model: '品質モード',
            },
        },
    },
};

module.exports = { MESSAGES };
