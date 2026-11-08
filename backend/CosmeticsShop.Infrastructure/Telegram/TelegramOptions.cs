namespace CosmeticsShop.Infrastructure.Telegram;

public sealed class TelegramOptions
{
    public const string SectionName = "Telegram";
    public bool Enabled { get; init; }
    public string BotToken { get; init; } = "";
    public string MiniAppUrl { get; init; } = "";
    public int InitDataMaxAgeSeconds { get; init; } = 3600;

    /// <summary>
    /// Optional proxy for Bot API requests only, for example a local xray/sing-box client
    /// (<c>socks5://127.0.0.1:1080</c>). Empty means a direct connection. Read once at startup.
    /// </summary>
    public string ProxyUrl { get; init; } = "";
}
