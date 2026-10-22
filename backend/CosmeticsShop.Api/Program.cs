using CosmeticsShop.Application.Abstractions;
using CosmeticsShop.Contracts.Common;
using CosmeticsShop.Infrastructure;
using CosmeticsShop.Api.Endpoints;
using CosmeticsShop.Application.Auth;
using System.Globalization;
using CosmeticsShop.Api.Errors;
using CosmeticsShop.Api.Hosting;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole();
builder.Configuration
    .AddJsonFile("appsettings.Local.json", optional: true)
    .AddJsonFile("appsettings.Tunnel.json", optional: true, reloadOnChange: true)
    .AddEnvironmentVariables();
builder.Services.AddShopProblemDetails();
builder.Services.AddExceptionHandler<ShopExceptionHandler>();
builder.Services.AddInfrastructure(builder.Configuration);
builder.Services.AddTelegramAuthentication();
builder.Services.AddTrustedProxy(builder.Configuration);

var app = builder.Build();
if (args.Length == 2 && args[0] == "--grant-admin")
{
    if (!long.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out var telegramId) || telegramId <= 0)
        throw new ArgumentException("A positive Telegram ID is required.");
    await using var scope = app.Services.CreateAsyncScope();
    await scope.ServiceProvider.GetRequiredService<IUserAccess>().GrantAdminAsync(telegramId, CancellationToken.None);
    Console.WriteLine("Administrator role saved.");
    return;
}
app.UseRequestDiagnostics();
app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseForwardedHeaders();
app.UseAuthentication();
app.UseAuthorization();
var frontendPublished = Directory.Exists(Path.Combine(app.Environment.ContentRootPath, "wwwroot"));
if (frontendPublished)
{
    app.UseDefaultFiles();
    app.UseStaticFiles();
}

app.MapGet("/api/app", () => Results.Ok(new AppInfoResponse("Магазин косметики")));
app.MapCatalog();
app.MapTelegramAuthentication();
app.MapAdminReferences();
app.MapAdminProducts();
app.MapGet("/api/health/live", () => Results.Ok(new HealthResponse("ok")));
app.MapGet("/api/health/ready", async (IApplicationReadiness readiness, CancellationToken cancellationToken) =>
{
    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
    timeout.CancelAfter(TimeSpan.FromSeconds(3));
    try
    {
        return await readiness.IsReadyAsync(timeout.Token)
            ? Results.Ok(new HealthResponse("ready"))
            : Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
    }
    catch (Exception) when (!cancellationToken.IsCancellationRequested)
    {
        return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
    }
});

// Unknown API routes must never return the frontend HTML document.
app.Map("/api/{**path}", () => Results.NotFound());
if (frontendPublished)
{
    app.MapFallbackToFile("index.html");
}
app.Run();
