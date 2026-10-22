using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CosmeticsShop.Application.Auth;
using CosmeticsShop.Infrastructure.Telegram;
using Microsoft.Extensions.Options;

namespace CosmeticsShop.Infrastructure.Auth;

public sealed class TelegramInitDataValidator(IOptions<TelegramOptions> options, TimeProvider clock) : ITelegramIdentityValidator
{
    private static readonly TelegramInitDataCheck Invalid = new(TelegramInitDataStatus.Invalid);

    public long? Validate(string initData) => Check(initData).TelegramId;

    public TelegramInitDataCheck Check(string initData)
    {
        if (string.IsNullOrWhiteSpace(options.Value.BotToken) || initData.Length is 0 or > 8192) return Invalid;
        var fields = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var pair in initData.Split('&'))
        {
            var separator = pair.IndexOf('=');
            if (separator <= 0 || !ValidEscapes(pair)) return Invalid;
            var key = WebUtility.UrlDecode(pair[..separator]);
            var value = WebUtility.UrlDecode(pair[(separator + 1)..]);
            if (key.Length == 0 || key.Any(character => !char.IsAsciiLetterOrDigit(character) && character != '_')
                || !fields.TryAdd(key, value)) return Invalid;
        }
        if (!fields.Remove("hash", out var hash) || hash.Length != 64
            || !fields.TryGetValue("auth_date", out var date)
            || !long.TryParse(date, NumberStyles.None, CultureInfo.InvariantCulture, out var authDate)
            || !fields.TryGetValue("user", out var userJson)) return Invalid;
        byte[] received;
        try { received = Convert.FromHexString(hash); }
        catch (FormatException) { return Invalid; }
        var secret = HMACSHA256.HashData("WebAppData"u8, Encoding.UTF8.GetBytes(options.Value.BotToken));
        var checkString = string.Join('\n', fields.Select(field => $"{field.Key}={field.Value}"));
        var expected = HMACSHA256.HashData(secret, Encoding.UTF8.GetBytes(checkString));
        if (!CryptographicOperations.FixedTimeEquals(received, expected)) return Invalid;
        // Age is checked only for authentic data, so "expired" never describes a forged value.
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        if (authDate <= 0 || authDate > now + 30) return Invalid;
        if (now - authDate > options.Value.InitDataMaxAgeSeconds) return new(TelegramInitDataStatus.Expired);
        try
        {
            using var user = JsonDocument.Parse(userJson);
            var root = user.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || root.EnumerateObject().Select(property => property.Name).Distinct(StringComparer.Ordinal).Count() != root.EnumerateObject().Count()
                || !root.TryGetProperty("id", out var id) || !id.TryGetInt64(out var telegramId) || telegramId <= 0) return Invalid;
            return new(TelegramInitDataStatus.Valid, telegramId);
        }
        catch (JsonException) { return Invalid; }
        catch (InvalidOperationException) { return Invalid; }
    }

    private static bool ValidEscapes(string value)
    {
        for (var index = 0; index < value.Length; index++)
        {
            if (value[index] != '%') continue;
            if (index + 2 >= value.Length || !Uri.IsHexDigit(value[index + 1]) || !Uri.IsHexDigit(value[index + 2])) return false;
            index += 2;
        }
        return true;
    }
}
