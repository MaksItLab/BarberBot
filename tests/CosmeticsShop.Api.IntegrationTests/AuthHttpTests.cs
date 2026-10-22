using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using CosmeticsShop.Api.Endpoints;
using CosmeticsShop.Application.Auth;
using CosmeticsShop.Contracts.Auth;
using CosmeticsShop.Domain;
using CosmeticsShop.Infrastructure.Auth;
using CosmeticsShop.Infrastructure.Telegram;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace CosmeticsShop.Api.IntegrationTests;

public sealed class AuthHttpTests(PostgresFixture fixture) : IClassFixture<PostgresFixture>
{
    [Fact]
    public async Task RegistrationIgnoresBodyRoleAndEveryRequestUsesCurrentDatabaseRole()
    {
        await using var app = BuildApp("Development");
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        using var anonymous = await client.PostAsync("/api/auth/telegram", null);
        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);
        Assert.Equal("application/problem+json", anonymous.Content.Headers.ContentType?.MediaType);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("tma", TelegramValidationTests.Golden);
        using var create = await client.PostAsJsonAsync("/api/auth/telegram", new { role = "Admin", telegramId = "1" });
        Assert.Equal(HttpStatusCode.OK, create.StatusCode);
        var user = await create.Content.ReadFromJsonAsync<CurrentUserResponse>();
        Assert.Equal(new CurrentUserResponse("9000000001", "Customer"), user);
        using var again = await client.PostAsync("/api/auth/telegram", null);
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        await using var db = fixture.CreateContext();
        Assert.Equal(1, await db.Users.CountAsync());
        using var denied = await client.GetAsync("/api/admin/probe");
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        var users = new UserAccess(db);
        await users.GrantAdminAsync(9_000_000_001, default);
        using var allowed = await client.GetAsync("/api/admin/probe");
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
        using var registerAdmin = await client.PostAsync("/api/auth/telegram", null);
        Assert.Equal("Admin", (await registerAdmin.Content.ReadFromJsonAsync<CurrentUserResponse>())!.Role);
        await db.Users.ExecuteUpdateAsync(setters => setters.SetProperty(value => value.Role, UserRole.Customer));
        using var demoted = await client.GetAsync("/api/admin/probe");
        Assert.Equal(HttpStatusCode.Forbidden, demoted.StatusCode);
        using var me = await client.GetAsync("/api/me");
        Assert.Equal("Customer", (await me.Content.ReadFromJsonAsync<CurrentUserResponse>())!.Role);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("tma", TelegramValidationTests.Golden.Replace("test-query", "fake"));
        using var invalid = await client.GetAsync("/api/me");
        Assert.Equal(HttpStatusCode.Unauthorized, invalid.StatusCode);
        await app.StopAsync();
    }

    [Fact]
    public async Task ProductionRejectsInitDataOverPlainHttp()
    {
        await using var app = BuildApp("Production");
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("tma", TelegramValidationTests.Golden);
        using var response = await client.PostAsync("/api/auth/telegram", null);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        await app.StopAsync();
    }

    private WebApplication BuildApp(string environment)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = environment });
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.AddScoped(_ => fixture.CreateContext());
        builder.Services.AddScoped<IUserAccess, UserAccess>();
        builder.Services.AddSingleton<ITelegramIdentityValidator>(new TelegramInitDataValidator(
            Options.Create(new TelegramOptions { BotToken = TelegramValidationTests.Token }), new TelegramValidationTests.FixedClock()));
        builder.Services.AddTelegramAuthentication();
        var app = builder.Build();
        app.UseAuthentication(); app.UseAuthorization();
        app.MapTelegramAuthentication();
        app.MapGet("/api/admin/probe", () => "ok").RequireAuthorization("Admin");
        return app;
    }
}
