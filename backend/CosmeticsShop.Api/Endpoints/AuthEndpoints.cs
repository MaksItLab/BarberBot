using System.Globalization;
using System.Security.Claims;
using CosmeticsShop.Api.Auth;
using CosmeticsShop.Api.Hosting;
using CosmeticsShop.Application.Auth;
using Microsoft.AspNetCore.Authentication;

namespace CosmeticsShop.Api.Endpoints;

public static class AuthEndpoints
{
    public static IServiceCollection AddTelegramAuthentication(this IServiceCollection services)
    {
        services.AddAuthentication(TelegramAuthenticationHandler.SchemeName)
            .AddScheme<AuthenticationSchemeOptions, TelegramAuthenticationHandler>(TelegramAuthenticationHandler.SchemeName, _ => { });
        services.AddAuthorizationBuilder().AddPolicy("Admin", policy => policy.RequireAuthenticatedUser().RequireRole("Admin"));
        return services;
    }

    public static void MapTelegramAuthentication(this WebApplication app)
    {
        app.MapPost("/api/auth/telegram", async (ClaimsPrincipal principal, IUserAccess users, CancellationToken ct) =>
            Results.Ok(await users.RegisterCustomerAsync(TelegramId(principal), ct))).RequireAuthorization();
        app.MapGet("/api/me", async (ClaimsPrincipal principal, IUserAccess users, CancellationToken ct) =>
        {
            var user = await users.FindAsync(TelegramId(principal), ct);
            return user is null ? Results.Problem(statusCode: 401, title: "Сначала откройте магазин заново из Telegram.",
                extensions: new Dictionary<string, object?> { ["code"] = ShopErrorCodes.UserNotFound }) : Results.Ok(user);
        }).RequireAuthorization();
    }

    private static long TelegramId(ClaimsPrincipal principal) => long.Parse(principal.FindFirstValue(ClaimTypes.NameIdentifier)!, CultureInfo.InvariantCulture);
}
