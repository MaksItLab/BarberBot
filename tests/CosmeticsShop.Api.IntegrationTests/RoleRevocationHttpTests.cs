using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using CosmeticsShop.Contracts.Admin;
using CosmeticsShop.Domain;
using Microsoft.EntityFrameworkCore;

namespace CosmeticsShop.Api.IntegrationTests;

/// <summary>R03: with a check on every request, a revoked role stops every admin operation at once, with the same initData.</summary>
public sealed class RoleRevocationHttpTests(PostgresFixture fixture) : IClassFixture<PostgresFixture>
{
    [Fact]
    public async Task RevokedRoleStopsSavesReadsAndOutcomeChecksWithoutWriting()
    {
        await using var app = TestShopHost.Create(fixture); await app.StartAsync();
        var products = new AdminProductHttpTests(fixture);
        using var client = await products.AdminClient(app.Urls.Single());
        using var created = await client.PostAsJsonAsync("/api/admin/products", await products.Input());
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var product = (await created.Content.ReadFromJsonAsync<AdminProduct>())!;

        await using (var db = fixture.CreateContext())
            await db.Users.Where(user => user.TelegramId == 9_000_000_001)
                .ExecuteUpdateAsync(setters => setters.SetProperty(user => user.Role, UserRole.Customer));

        var key = Guid.NewGuid();
        using var update = new HttpRequestMessage(HttpMethod.Put, $"/api/admin/products/{product.Id}")
            { Content = JsonContent.Create(AdminProductHttpTests.From(product) with { Name = "После снятия роли" }) };
        update.Headers.Add("Idempotency-Key", key.ToString());
        using var save = await client.SendAsync(update);
        await AssertForbidden(save);
        using var create = await client.PostAsJsonAsync("/api/admin/products", await products.Input());
        await AssertForbidden(create);
        using var read = await client.GetAsync($"/api/admin/products/{product.Id}");
        await AssertForbidden(read);
        using var outcome = await client.GetAsync($"/api/admin/operations/{key}");
        await AssertForbidden(outcome);

        await using (var db = fixture.CreateContext())
        {
            Assert.Equal(product.Name, (await db.Products.SingleAsync(value => value.Id == long.Parse(product.Id))).Name);
            Assert.False(await db.SaveOperations.AnyAsync(value => value.Key == key), "a refused save does not take its key");
        }
        // Login still works and reports the current role, so the interface can show "no rights" instead of an error.
        using var login = await client.PostAsync("/api/auth/telegram", null);
        Assert.Equal("Customer", (await login.Content.ReadFromJsonAsync<CosmeticsShop.Contracts.Auth.CurrentUserResponse>())!.Role);

        // Granting the role again restores access with the same initData, without a new login.
        await using (var db = fixture.CreateContext())
            await new CosmeticsShop.Infrastructure.Auth.UserAccess(db).GrantAdminAsync(9_000_000_001, default);
        using var again = await client.GetAsync($"/api/admin/products/{product.Id}");
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        await app.StopAsync();
    }

    private static async Task AssertForbidden(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        using var problem = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal("forbidden", problem.RootElement.GetProperty("code").GetString());
    }
}
