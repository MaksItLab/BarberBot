using System.Net;

namespace CosmeticsShop.Infrastructure.Telegram;

/// <summary>Builds the HTTP client for Bot API requests, optionally through <see cref="TelegramOptions.ProxyUrl"/>.</summary>
internal static class TelegramHttp
{
    public const string ProxyUrlError =
        "Telegram:ProxyUrl must be http://, https://, socks4://, socks4a:// or socks5:// with a host and port, " +
        "without a login, path or query.";

    // SocketsHttpHandler supports these schemes. SOCKS4a/5 pass the host name to the proxy,
    // so api.telegram.org is resolved on the far side and local DNS filtering does not matter.
    private static readonly string[] SupportedSchemes = ["http", "https", "socks4", "socks4a", "socks5"];

    public static bool IsValidProxyUrl(string? value) =>
        string.IsNullOrWhiteSpace(value) || TryParse(value, out _);

    public static HttpClient CreateClient(TelegramOptions options)
    {
        var handler = new SocketsHttpHandler();
        if (TryParse(options.ProxyUrl, out var proxy))
        {
            handler.Proxy = new WebProxy(proxy);
            handler.UseProxy = true;
        }
        return new HttpClient(handler, disposeHandler: true) { Timeout = TimeSpan.FromSeconds(45) };
    }

    /// <summary>A log-safe description: only scheme, host and port.</summary>
    public static string? Describe(string? value) =>
        TryParse(value, out var uri) ? $"{uri.Scheme}://{uri.Host}:{uri.Port}" : null;

    private static bool TryParse(string? value, out Uri uri)
    {
        uri = null!;
        if (string.IsNullOrWhiteSpace(value) ||
            !Uri.TryCreate(value.Trim(), UriKind.Absolute, out var parsed) ||
            !SupportedSchemes.Contains(parsed.Scheme) ||
            string.IsNullOrEmpty(parsed.Host) || parsed.Port <= 0 ||
            parsed.UserInfo.Length > 0 || parsed.AbsolutePath != "/" ||
            parsed.Query.Length > 0 || parsed.Fragment.Length > 0)
        {
            return false;
        }
        uri = parsed;
        return true;
    }
}
