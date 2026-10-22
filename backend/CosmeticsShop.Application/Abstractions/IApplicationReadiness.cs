namespace CosmeticsShop.Application.Abstractions;

public interface IApplicationReadiness
{
    Task<bool> IsReadyAsync(CancellationToken cancellationToken = default);
}
