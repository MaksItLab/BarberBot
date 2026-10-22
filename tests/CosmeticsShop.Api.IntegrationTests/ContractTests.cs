using System.Text.Json;
using CosmeticsShop.Contracts.Common;

namespace CosmeticsShop.Api.IntegrationTests;

public sealed class ContractTests
{
    [Fact]
    public void AppResponsePreservesExistingJsonShape()
    {
        var response = new AppInfoResponse("Магазин косметики");
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(response, JsonSerializerOptions.Web));
        Assert.Single(json.RootElement.EnumerateObject());
        Assert.Equal(response.Name, json.RootElement.GetProperty("name").GetString());
    }

    [Fact]
    public void HealthResponsePreservesExistingJsonShape()
    {
        Assert.Equal("{\"status\":\"ok\"}",
            JsonSerializer.Serialize(new HealthResponse("ok"), JsonSerializerOptions.Web));
    }
}
