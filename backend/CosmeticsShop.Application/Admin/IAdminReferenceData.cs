using CosmeticsShop.Contracts.Admin;

namespace CosmeticsShop.Application.Admin;

public interface IAdminReferenceData
{
    Task<IReadOnlyList<BrandResponse>> GetBrandsAsync(CancellationToken cancellationToken);
    Task<IReadOnlyList<TypeResponse>> GetTypesAsync(CancellationToken cancellationToken);
    Task<BrandResponse> SaveBrandAsync(long? id, SaveBrandRequest request, CancellationToken cancellationToken);
    Task<TypeResponse> SaveTypeAsync(long? id, SaveTypeRequest request, CancellationToken cancellationToken);
}
