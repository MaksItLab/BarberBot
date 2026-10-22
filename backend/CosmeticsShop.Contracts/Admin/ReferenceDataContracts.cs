namespace CosmeticsShop.Contracts.Admin;

public sealed record BrandResponse(string Id, string Name, string? Description);
public sealed record TypeResponse(string Id, string Name);
public sealed record SaveBrandRequest(string? Name, string? Description);
public sealed record SaveTypeRequest(string? Name);
