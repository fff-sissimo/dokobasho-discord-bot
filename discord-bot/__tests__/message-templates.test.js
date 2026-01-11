const { MESSAGES } = require('../src/message-templates');

describe('message templates', () => {
    it('formats reminder notification text', () => {
        expect(MESSAGES.reminders.notification('test')).toBe('やっほ、リマインダーだよ！\n\n**内容:**\n test');
    });

    it('formats validation errors', () => {
        expect(MESSAGES.errors.invalidTime).toContain('時刻の指定が正しくない');
        expect(MESSAGES.errors.invalidTimezone).toContain('タイムゾーン');
        expect(MESSAGES.errors.keyGenerationFailed).toContain('キーがうまく');
    });

    it('formats create responses', () => {
        const displayDate = '<t:1:F>';
        expect(MESSAGES.responses.created('k1', displayDate)).toContain('✅ リマインダーを登録したよ！');
    });

    it('formats list responses', () => {
        const item = MESSAGES.responses.listItem('key', 'content', '<t:1:R>');
        expect(item).toBe('- `key`: content... (通知: <t:1:R>)');
        const header = MESSAGES.responses.listHeader('user', 3, 2, item);
        expect(header).toContain('**リマインダー一覧 (user) - 3件中2件表示だよ**');
    });

    it('formats delete responses', () => {
        expect(MESSAGES.responses.adminRequiredForCreate).toContain('管理者');
        expect(MESSAGES.responses.adminRequiredForDelete).toContain('管理者');
        expect(MESSAGES.responses.channelRequiredForServerScope).toContain('通知チャンネル');
        expect(MESSAGES.responses.getDisabled).toContain('止めてある');
        expect(MESSAGES.responses.notFound).toContain('見つからない');
        expect(MESSAGES.responses.listEmpty).toContain('ないよ');
        expect(MESSAGES.responses.deleteConfirmLabel).toBe('うん、削除する');
        expect(MESSAGES.responses.deleteConfirm('test')).toContain('本当にリマインダー「test」を削除する？');
        expect(MESSAGES.responses.deleteSuccess('test')).toContain('✅ リマインダー「test」を削除したよ。');
        expect(MESSAGES.responses.alreadyDeleted).toContain('もう消えてる');
    });
});
