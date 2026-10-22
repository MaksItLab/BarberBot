namespace CosmeticsShop.Infrastructure.Telegram;

public sealed class TelegramOptions
{
    public const string SectionName = "Telegram";
    public bool Enabled { get; init; }
    public string BotToken { get; init; } = "";
    public string MiniAppUrl { get; init; } = "";
    public int InitDataMaxAgeSeconds { get; init; } = 3600;
}
