using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Telegram.Bot;
using Telegram.Bot.Exceptions;
using Telegram.Bot.Types;
using Telegram.Bot.Types.Enums;
using Telegram.Bot.Types.ReplyMarkups;

namespace CosmeticsShop.Infrastructure.Telegram;

internal sealed class TelegramBotWorker(
    IOptionsMonitor<TelegramOptions> options,
    ILogger<TelegramBotWorker> logger,
    HttpClient httpClient) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var settings = options.CurrentValue;
        if (!settings.Enabled)
        {
            logger.LogInformation("Telegram bot is disabled.");
            return;
        }

        var bot = new TelegramBotClient(settings.BotToken, httpClient);
        var offset = 0;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var updates = await bot.GetUpdates(offset: offset, timeout: 30,
                    allowedUpdates: [UpdateType.Message], cancellationToken: stoppingToken);

                foreach (var update in updates)
                {
                    try
                    {
                        if (update.Message is { Chat.Type: ChatType.Private, Text: { } text } message &&
                            text.Split(' ', 2)[0].Split('@', 2)[0] == "/start")
                        {
                            await bot.SendMessage(chatId: message.Chat.Id,
                                text: "Добро пожаловать в магазин косметики! Откройте приложение, чтобы перейти в магазин.",
                                replyMarkup: new InlineKeyboardMarkup(
                                    InlineKeyboardButton.WithWebApp("Открыть магазин",
                                        new WebAppInfo { Url = options.CurrentValue.MiniAppUrl })),
                                cancellationToken: stoppingToken);
                        }
                    }
                    catch (ApiRequestException exception) when (exception.ErrorCode == 403)
                    {
                        // A permanently inaccessible chat must not block later updates.
                        logger.LogInformation("Telegram chat is unavailable; skipping its reply.");
                    }
                    offset = update.Id + 1;
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                // Exception messages and request URLs can contain the bot token.
                logger.LogWarning("Telegram request failed ({ErrorType}); retrying in 5 seconds.",
                    exception.GetType().Name);
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
        }
    }

    public override void Dispose()
    {
        base.Dispose();
        httpClient.Dispose();
    }
}
