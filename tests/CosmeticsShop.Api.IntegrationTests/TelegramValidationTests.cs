using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using CosmeticsShop.Infrastructure.Auth;
using CosmeticsShop.Infrastructure.Telegram;
using Microsoft.Extensions.Options;

namespace CosmeticsShop.Api.IntegrationTests;

public sealed class TelegramValidationTests
{
    internal const string Token = "123456:test-only";
    internal const long Now = 1792051200;
    // Golden value produced independently with Python's hmac/hashlib and urllib.parse.
    internal const string Golden = "auth_date=1792051200&query_id=test-query&user=%7B%22id%22%3A9000000001%2C%22first_name%22%3A%22Test%22%7D&hash=2a720b9be302b994a378813075eb776f2942d16454e67ade2a52053fc2d7da22";
    private readonly TelegramInitDataValidator validator = new(Options.Create(new TelegramOptions { BotToken = Token }), new FixedClock());

    [Fact]
    public void AcceptsIndependentGoldenVectorAndLargeId() => Assert.Equal(9_000_000_001, validator.Validate(Golden));

    [Theory]
    [InlineData(0, true)] [InlineData(-3600, true)] [InlineData(-3601, false)]
    [InlineData(30, true)] [InlineData(31, false)]
    public void EnforcesAgeAndFutureClockTolerance(int offset, bool expected) =>
        Assert.Equal(expected, validator.Validate(Sign(Now + offset)) is not null);

    [Fact]
    public void RejectsTamperingWrongTokenDuplicateKeysAndMalformedEncoding()
    {
        Assert.Null(validator.Validate(Golden.Replace("test-query", "changed")));
        Assert.Null(validator.Validate(Golden + "&auth_date=1792051200"));
        Assert.Null(validator.Validate(Golden + "&%61uth_date=1792051200"));
        Assert.Null(validator.Validate(Golden + "&extra=%GG"));
        Assert.Null(validator.Validate(Golden.Replace("hash=2", "hash=z")));
        Assert.Null(validator.Validate("auth_date=1&user={}"));
        Assert.Null(validator.Validate(new string('a', 8193)));
        var other = new TelegramInitDataValidator(Options.Create(new TelegramOptions { BotToken = "other" }), new FixedClock());
        Assert.Null(other.Validate(Golden));
    }

    [Theory]
    [InlineData("{}")] [InlineData("null")] [InlineData("{\"id\":-1}")]
    [InlineData("{\"id\":\"1\"}")] [InlineData("{\"id\":1,\"id\":2}")] [InlineData("bad-json")]
    public void RejectsInvalidSignedUser(string user) => Assert.Null(validator.Validate(Sign(Now, user)));

    [Fact]
    public void HandlesSignedUnicodeAndSignatureFieldWithoutTrustingClientRole()
    {
        Assert.Equal(123, validator.Validate(Sign(Now, "{\"id\":123,\"first_name\":\"Анна + Лена\",\"role\":\"Admin\"}", "signature", "test-signature")));
    }

    internal static string Sign(long date = Now, string user = "{\"id\":9000000001}", string? extraKey = null, string? extraValue = null)
    {
        var fields = new SortedDictionary<string, string>(StringComparer.Ordinal)
        {
            ["auth_date"] = date.ToString(CultureInfo.InvariantCulture), ["user"] = user
        };
        if (extraKey is not null) fields.Add(extraKey, extraValue!);
        var check = string.Join('\n', fields.Select(field => $"{field.Key}={field.Value}"));
        var secret = HMACSHA256.HashData("WebAppData"u8, Encoding.UTF8.GetBytes(Token));
        fields.Add("hash", Convert.ToHexStringLower(HMACSHA256.HashData(secret, Encoding.UTF8.GetBytes(check))));
        return string.Join('&', fields.Select(field => $"{Uri.EscapeDataString(field.Key)}={Uri.EscapeDataString(field.Value)}"));
    }

    internal sealed class FixedClock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.FromUnixTimeSeconds(Now);
    }
}
