using CosmeticsShop.Application.Abstractions;
using CosmeticsShop.Application.Catalog;
using CosmeticsShop.Infrastructure.Catalog;
using CosmeticsShop.Application.Auth;
using CosmeticsShop.Infrastructure.Auth;
using CosmeticsShop.Application.Admin;
using CosmeticsShop.Infrastructure.Admin;
using CosmeticsShop.Infrastructure.Data;
using CosmeticsShop.Infrastructure.Telegram;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace CosmeticsShop.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddDbContext<ShopDbContext>(options =>
            options.UseNpgsql(configuration.GetConnectionString("Shop")));
        services.AddScoped<IApplicationReadiness, DatabaseReadiness>();
        services.AddScoped<ICatalogReader, CatalogReader>();
        services.AddScoped<IUserAccess, UserAccess>();
        services.AddScoped<IAdminReferenceData, AdminReferenceData>();
        services.AddScoped<IAdminProducts, AdminProducts>();
        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<ITelegramIdentityValidator, TelegramInitDataValidator>();
        services.AddOptions<TelegramOptions>()
            .Bind(configuration.GetSection(TelegramOptions.SectionName))
            .Validate(options => options.InitDataMaxAgeSeconds is >= 60 and <= 86400,
                "Telegram:InitDataMaxAgeSeconds must be between 60 and 86400.")
            .Validate(options => !options.Enabled || !string.IsNullOrWhiteSpace(options.BotToken),
                "Telegram:BotToken is required when the bot is enabled.")
            .Validate(options => !options.Enabled ||
                (Uri.TryCreate(options.MiniAppUrl, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps),
                "Telegram:MiniAppUrl must be a public HTTPS URL when the bot is enabled.")
            .ValidateOnStart();
        services.AddHostedService(provider => new TelegramBotWorker(
            provider.GetRequiredService<IOptionsMonitor<TelegramOptions>>(),
            provider.GetRequiredService<ILogger<TelegramBotWorker>>(),
            new HttpClient { Timeout = TimeSpan.FromSeconds(45) }));
        return services;
    }
}
