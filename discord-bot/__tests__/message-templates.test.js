const { MESSAGES } = require('../src/message-templates');

describe('message templates', () => {
    it('formats reminder notification text', () => {
        expect(MESSAGES.reminders.notification('test')).toBe('**リマインダー:** test');
    });

    it('formats validation errors', () => {
        expect(MESSAGES.errors.invalidTime).toContain('時刻の指定が正しくありません');
        expect(MESSAGES.errors.invalidTimezone).toContain('タイムゾーン');
    });

    it('formats create responses', () => {
        const displayDate = '<t:1:F>';
        expect(MESSAGES.responses.created('k1', displayDate)).toContain('✅ リマインダーを登録しました！');
    });

    it('formats list responses', () => {
        const item = MESSAGES.responses.listItem('key', 'content', '<t:1:R>');
        expect(item).toBe('- `key`: content... (通知: <t:1:R>)');
        const header = MESSAGES.responses.listHeader('user', 3, 2, item);
        expect(header).toContain('**リマインダー一覧 (user) - 3件中2件表示**');
    });

    it('formats delete responses', () => {
        expect(MESSAGES.responses.adminRequiredForCreate).toContain('作成するには');
        expect(MESSAGES.responses.adminRequiredForDelete).toContain('削除するには');
        expect(MESSAGES.responses.channelRequiredForServerScope).toContain('通知先チャンネル');
        expect(MESSAGES.responses.getDisabled).toContain('停止中');
        expect(MESSAGES.responses.notFound).toContain('見つかりませんでした');
        expect(MESSAGES.responses.listEmpty).toContain('登録されているリマインダーはありません');
        expect(MESSAGES.responses.deleteConfirmLabel).toBe('はい、削除します');
        expect(MESSAGES.responses.deleteConfirm('test')).toContain('本当にリマインダー「test」を削除しますか？');
        expect(MESSAGES.responses.deleteSuccess('test')).toContain('✅ リマインダー「test」を削除しました。');
        expect(MESSAGES.responses.alreadyDeleted).toContain('既に削除されているようです');
    });
});
