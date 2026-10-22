using System.Diagnostics;
using System.Globalization;
using System.Security.Claims;
using System.Text.Encodings.Web;
using CosmeticsShop.Api.Hosting;
using CosmeticsShop.Application.Auth;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace CosmeticsShop.Api.Auth;

public sealed class TelegramAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder,
    ITelegramIdentityValidator validator, IUserAccess users, IHostEnvironment environment)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "Telegram";
    private static readonly object FailureCode = new();

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var started = Stopwatch.GetTimestamp();
        try { return await AuthenticateTelegramAsync(); }
        finally { RequestDiagnostics.RecordAuthenticationTime(Context, Stopwatch.GetElapsedTime(started)); }
    }

    private async Task<AuthenticateResult> AuthenticateTelegramAsync()
    {
        if (!Request.Headers.TryGetValue("Authorization", out var header)) return AuthenticateResult.NoResult();
        if (!Request.IsHttps && !environment.IsDevelopment())
        {
            Context.Items[FailureCode] = ShopErrorCodes.SecureTransportUnavailable;
            // Record only transport flags; never log authorization data or user addresses.
            Logger.LogWarning("Telegram HTTPS check failed. Loopback: {Loopback}; forwarded protocol header: {Forwarded}; original protocol header: {Original}.",
                Context.Connection.RemoteIpAddress is { } remote && System.Net.IPAddress.IsLoopback(remote),
                Request.Headers.ContainsKey("X-Forwarded-Proto"), Request.Headers.ContainsKey("X-Original-Proto"));
            return AuthenticateResult.Fail("Invalid Telegram authentication.");
        }
        if (header.Count != 1
            || header[0] is not { } value || !value.StartsWith("tma ", StringComparison.OrdinalIgnoreCase))
            return Fail(ShopErrorCodes.AuthInvalid);
        var check = validator.Check(value[4..]);
        if (check.Status == TelegramInitDataStatus.Expired) return Fail(ShopErrorCodes.AuthExpired);
        if (check is not { Status: TelegramInitDataStatus.Valid, TelegramId: { } telegramId }) return Fail(ShopErrorCodes.AuthInvalid);
        var user = await users.FindAsync(telegramId, Context.RequestAborted);
        var claims = new List<Claim> { new(ClaimTypes.NameIdentifier, telegramId.ToString(CultureInfo.InvariantCulture)) };
        if (user is not null) claims.Add(new Claim(ClaimTypes.Role, user.Role));
        return AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(claims, SchemeName)), SchemeName));
    }

    private AuthenticateResult Fail(string code)
    {
        Context.Items[FailureCode] = code;
        return AuthenticateResult.Fail("Invalid Telegram authentication.");
    }

    protected override Task HandleChallengeAsync(AuthenticationProperties properties) =>
        (Context.Items[FailureCode] as string ?? ShopErrorCodes.AuthMissing) switch
        {
            ShopErrorCodes.SecureTransportUnavailable => WriteProblem(503, "Не удалось подтвердить защищённое соединение. Повторите попытку.",
                ShopErrorCodes.SecureTransportUnavailable),
            ShopErrorCodes.AuthExpired => WriteProblem(401, "Вход истёк. Откройте приложение заново из Telegram.", ShopErrorCodes.AuthExpired),
            ShopErrorCodes.AuthInvalid => WriteProblem(401, "Вход недействителен. Откройте приложение заново из Telegram.", ShopErrorCodes.AuthInvalid),
            _ => WriteProblem(401, "Нет данных входа Telegram. Откройте магазин из Telegram.", ShopErrorCodes.AuthMissing)
        };

    protected override Task HandleForbiddenAsync(AuthenticationProperties properties) =>
        WriteProblem(403, "Недостаточно прав.", ShopErrorCodes.Forbidden);

    private Task WriteProblem(int status, string title, string code) => Results.Problem(statusCode: status, title: title,
        extensions: new Dictionary<string, object?> { ["code"] = code }).ExecuteAsync(Context);
}
