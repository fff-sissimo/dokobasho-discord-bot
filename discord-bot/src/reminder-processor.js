const logger = require('./logger');
const { getPendingReminders, updateReminder } = require('./google-sheets');
const { calculateNextDate } = require('./utils');
const { MESSAGES } = require('./message-templates');

/**
 * Processes pending reminders, sends notifications, and updates their status.
 * @param {import('discord.js').Client} discordClient - The Discord client instance.
 */
async function processReminders(discordClient) {
    logger.debug('Checking for pending reminders...');
    
    let reminders;
    try {
        reminders = await getPendingReminders();
    } catch (error) {
        logger.error({ err: error }, 'Error fetching pending reminders');
        return;
    }

    if (reminders.length === 0) {
        logger.debug('No reminders due.');
        return;
    }

    logger.info(`Found ${reminders.length} reminders to process.`);

    for (const reminder of reminders) {
        const rowIndex = reminder.rowIndex;
        try {
            // 1. Pessimistic Lock: Mark as 'sending'
            await updateReminder(reminder.id, { status: 'sending', last_sent: new Date().toISOString() }, { rowIndex });
            logger.debug({ reminderId: reminder.id }, 'Locked reminder.');

            // 2. Send notification
            const message = MESSAGES.reminders.notification(reminder.content);
            if (reminder.scope === 'user') {
                const user = await discordClient.users.fetch(reminder.user_id);
                if (user) await user.send(message);
                else logger.warn({ reminderId: reminder.id, userId: reminder.user_id }, 'User not found for reminder. Skipping.');
            } else if (reminder.scope === 'channel') {
                const channel = await discordClient.channels.fetch(reminder.channel_id);
                if (channel) await channel.send(message);
                else logger.warn({ reminderId: reminder.id, channelId: reminder.channel_id }, 'Channel not found for reminder. Skipping.');
            } else if (reminder.scope === 'server') {
                if (reminder.channel_id) {
                    const channel = await discordClient.channels.fetch(reminder.channel_id);
                    if (channel) await channel.send(message);
                    else logger.warn({ reminderId: reminder.id, channelId: reminder.channel_id }, 'Channel not found for server-scoped reminder. Skipping.');
                } else {
                    logger.warn({ reminderId: reminder.id }, 'Server-scoped reminder has no channel to send to. Skipping.');
                }
            }
            logger.info({ reminderId: reminder.id }, 'Sent notification.');

            // 3. Update status after sending
            if (reminder.recurring !== 'off') {
                const nextTime = calculateNextDate(reminder.notify_time_utc, reminder.recurring);
                await updateReminder(reminder.id, {
                    notify_time_utc: nextTime,
                    status: 'pending', // Reschedule
                    last_sent: new Date().toISOString(),
                }, { rowIndex });
                logger.debug({ reminderId: reminder.id }, 'Rescheduled reminder.');
            } else {
                await updateReminder(reminder.id, {
                    status: 'sent',
                    last_sent: new Date().toISOString(),
                }, { rowIndex });
                logger.debug({ reminderId: reminder.id }, 'Marked reminder as sent.');
            }
        } catch (error) {
            logger.error({ reminderId: reminder.id, err: error }, 'Failed to process reminder.');
            // Revert status to pending for retry, increment retry count
            const retryCount = parseInt(reminder.retry_count || '0', 10) + 1;
            const newStatus = retryCount >= 3 ? 'failed' : 'pending';
            
            if (newStatus === 'failed') {
                logger.error({ reminderId: reminder.id }, `Reminder has failed ${retryCount} times. Setting status to "failed".`);
            }
            
            await updateReminder(reminder.id, {
                status: newStatus,
                retry_count: retryCount,
            }, { rowIndex }).catch(err => {
                logger.error({ reminderId: reminder.id, err }, 'CRITICAL: Failed to update status for reminder after send failure.');
            });
        }
    }
}

module.exports = { processReminders };
