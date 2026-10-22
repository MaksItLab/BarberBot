using CosmeticsShop.Api.Endpoints;
using CosmeticsShop.Api.Errors;
using CosmeticsShop.Api.Hosting;
using CosmeticsShop.Application.Admin;
using CosmeticsShop.Application.Auth;
using CosmeticsShop.Application.Catalog;
using CosmeticsShop.Infrastructure.Admin;
using CosmeticsShop.Infrastructure.Auth;
using CosmeticsShop.Infrastructure.Catalog;
using CosmeticsShop.Infrastructure.Telegram;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Configuration;

namespace CosmeticsShop.Api.IntegrationTests;

internal static class TestShopHost
{
    public static WebApplication Create(PostgresFixture fixture, string environment = "Development", string? trustedProxy = null,
        Action<WebApplicationBuilder>? configure = null)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = environment });
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?> { ["ReverseProxy:KnownProxy"] = trustedProxy });
        builder.Services.AddTrustedProxy(builder.Configuration);
        builder.Services.AddScoped(_ => fixture.CreateContext());
        builder.Services.AddScoped<IUserAccess, UserAccess>();
        builder.Services.AddScoped<ICatalogReader, CatalogReader>();
        builder.Services.AddScoped<IAdminReferenceData, AdminReferenceData>();
        builder.Services.AddScoped<IAdminProducts, AdminProducts>();
        builder.Services.AddSingleton(TimeProvider.System);
        builder.Services.AddSingleton<ITelegramIdentityValidator>(new TelegramInitDataValidator(
            Options.Create(new TelegramOptions { BotToken = TelegramValidationTests.Token }), new TelegramValidationTests.FixedClock()));
        builder.Services.AddTelegramAuthentication();
        builder.Services.AddShopProblemDetails();
        builder.Services.AddExceptionHandler<ShopExceptionHandler>();
        configure?.Invoke(builder);
        var app = builder.Build();
        app.UseRequestDiagnostics(); app.UseExceptionHandler(); app.UseStatusCodePages(); app.UseForwardedHeaders(); app.UseAuthentication(); app.UseAuthorization();
        app.MapTelegramAuthentication(); app.MapCatalog(); app.MapAdminReferences(); app.MapAdminProducts();
        return app;
    }
}
