using System.Globalization;
using System.Security.Claims;
using System.Text.Encodings.Web;
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
    private static readonly object TransportFailure = new();

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!Request.Headers.TryGetValue("Authorization", out var header)) return AuthenticateResult.NoResult();
        if (!Request.IsHttps && !environment.IsDevelopment())
        {
            Context.Items[TransportFailure] = true;
            // Record only transport flags; never log authorization data or user addresses.
            Logger.LogWarning("Telegram HTTPS check failed. Loopback: {Loopback}; forwarded protocol header: {Forwarded}; original protocol header: {Original}.",
                Context.Connection.RemoteIpAddress is { } remote && System.Net.IPAddress.IsLoopback(remote),
                Request.Headers.ContainsKey("X-Forwarded-Proto"), Request.Headers.ContainsKey("X-Original-Proto"));
            return AuthenticateResult.Fail("Invalid Telegram authentication.");
        }
        if (header.Count != 1
            || header[0] is not { } value || !value.StartsWith("tma ", StringComparison.OrdinalIgnoreCase))
            return AuthenticateResult.Fail("Invalid Telegram authentication.");
        var telegramId = validator.Validate(value[4..]);
        if (telegramId is null) return AuthenticateResult.Fail("Invalid or expired Telegram authentication.");
        var user = await users.FindAsync(telegramId.Value, Context.RequestAborted);
        var claims = new List<Claim> { new(ClaimTypes.NameIdentifier, telegramId.Value.ToString(CultureInfo.InvariantCulture)) };
        if (user is not null) claims.Add(new Claim(ClaimTypes.Role, user.Role));
        return AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(claims, SchemeName)), SchemeName));
    }

    protected override Task HandleChallengeAsync(AuthenticationProperties properties) => Context.Items.ContainsKey(TransportFailure)
        ? Results.Problem(statusCode: 503, title: "Не удалось подтвердить защищённое соединение. Повторите попытку.",
            extensions: new Dictionary<string, object?> { ["code"] = "secure_transport_unavailable" }).ExecuteAsync(Context)
        : WriteProblem(401, "Вход истёк или недействителен. Откройте приложение заново из Telegram.");
    protected override Task HandleForbiddenAsync(AuthenticationProperties properties) => WriteProblem(403, "Недостаточно прав.");
    private Task WriteProblem(int status, string title) => Results.Problem(statusCode: status, title: title).ExecuteAsync(Context);
}
