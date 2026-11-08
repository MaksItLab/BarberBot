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
    HttpClient httpClient,
    TimeSpan? retryDelay = null,
    int alertAfterFailures = TelegramBotWorker.DefaultAlertAfterFailures) : BackgroundService
{
    // One error-level entry after this many failures in a row: from ~30 s (refused at once)
    // to a few minutes (45 s timeouts), so a dead proxy is visible in the log without flooding it.
    internal const int DefaultAlertAfterFailures = 6;
    private readonly TimeSpan pause = retryDelay ?? TimeSpan.FromSeconds(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var settings = options.CurrentValue;
        if (!settings.Enabled)
        {
            logger.LogInformation("Telegram bot is disabled.");
            return;
        }

        if (TelegramHttp.Describe(settings.ProxyUrl) is { } proxy)
        {
            logger.LogInformation("Telegram requests go through proxy {Proxy}.", proxy);
        }

        var bot = new TelegramBotClient(settings.BotToken, httpClient);
        var offset = 0;
        var failures = 0;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var updates = await bot.GetUpdates(offset: offset, timeout: 30,
                    allowedUpdates: [UpdateType.Message], cancellationToken: stoppingToken);
                if (failures > 0)
                {
                    logger.LogInformation("Telegram API is reachable again after {Failures} failed requests.", failures);
                    failures = 0;
                }

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
                failures++;
                logger.LogWarning("Telegram request failed ({ErrorType}); retrying in {Delay} seconds.",
                    exception.GetType().Name, pause.TotalSeconds);
                if (failures == alertAfterFailures)
                {
                    logger.LogError("Telegram API has been unreachable for {Failures} requests in a row; " +
                        "the bot does not answer. Check the network, the VPN client and Telegram:ProxyUrl.", failures);
                }
                await Task.Delay(pause, stoppingToken);
            }
        }
    }

    public override void Dispose()
    {
        base.Dispose();
        httpClient.Dispose();
    }
}
