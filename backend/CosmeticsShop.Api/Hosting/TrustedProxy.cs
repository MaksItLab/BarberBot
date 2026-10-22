using System.Net;
using Microsoft.AspNetCore.HttpOverrides;

namespace CosmeticsShop.Api.Hosting;

public static class TrustedProxy
{
    public static IServiceCollection AddTrustedProxy(this IServiceCollection services, IConfiguration configuration)
    {
        var configured = configuration["ReverseProxy:KnownProxy"];
        IPAddress? address = null;
        if (!string.IsNullOrWhiteSpace(configured) && !IPAddress.TryParse(configured, out address))
            throw new InvalidOperationException("ReverseProxy:KnownProxy must be the IP address of the trusted TLS proxy.");
        services.Configure<ForwardedHeadersOptions>(options =>
        {
            // With no configured proxy, forwarded protocol headers are ignored.
            options.ForwardedHeaders = address is null ? ForwardedHeaders.None : ForwardedHeaders.XForwardedProto;
            options.KnownProxies.Clear();
            options.KnownIPNetworks.Clear();
            if (address is not null)
            {
                options.KnownProxies.Add(address);
                if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
                    options.KnownProxies.Add(address.MapToIPv6());
            }
            options.ForwardLimit = 1;
        });
        return services;
    }
}
