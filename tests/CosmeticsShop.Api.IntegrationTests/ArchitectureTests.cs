using System.Reflection;
using System.Xml.Linq;

namespace CosmeticsShop.Api.IntegrationTests;

public sealed class ArchitectureTests
{
    [Fact]
    public void ProjectReferencesFollowLayerBoundaries()
    {
        var allowed = new Dictionary<string, string[]>
        {
            ["CosmeticsShop.Domain"] = [],
            ["CosmeticsShop.Contracts"] = [],
            ["CosmeticsShop.Application"] = ["CosmeticsShop.Domain", "CosmeticsShop.Contracts"],
            ["CosmeticsShop.Infrastructure"] = ["CosmeticsShop.Application", "CosmeticsShop.Domain"],
            ["CosmeticsShop.Api"] = ["CosmeticsShop.Application", "CosmeticsShop.Contracts", "CosmeticsShop.Infrastructure"]
        };
        var root = FindRepositoryRoot();

        foreach (var (project, expected) in allowed)
        {
            var document = XDocument.Load(Path.Combine(root, "backend", project, project + ".csproj"));
            var actual = document.Descendants().Where(element => element.Name.LocalName == "ProjectReference")
                .Select(element => Path.GetFileNameWithoutExtension(element.Attribute("Include")!.Value.Replace('\\', '/')))
                .ToHashSet(StringComparer.Ordinal);
            Assert.True(actual.SetEquals(expected), $"Invalid dependencies in {project}: {string.Join(", ", actual)}");
        }
    }

    [Fact]
    public void CompiledLayersDoNotUseForbiddenImplementationTypes()
    {
        AssertNoDependencies("CosmeticsShop.Contracts", "CosmeticsShop.", "Microsoft.EntityFrameworkCore", "Microsoft.AspNetCore", "Telegram.Bot", "Npgsql");
        AssertNoDependencies("CosmeticsShop.Domain", "CosmeticsShop.", "Microsoft.EntityFrameworkCore", "Microsoft.AspNetCore", "Telegram.Bot", "Npgsql");
        AssertNoDependencies("CosmeticsShop.Application", "CosmeticsShop.Infrastructure", "CosmeticsShop.Api", "Microsoft.EntityFrameworkCore", "Microsoft.AspNetCore", "Telegram.Bot", "Npgsql");
        AssertNoDependencies("CosmeticsShop.Infrastructure", "CosmeticsShop.Api");
        AssertNoDependencies("CosmeticsShop.Api", "CosmeticsShop.Domain", "Microsoft.EntityFrameworkCore", "Telegram.Bot", "Npgsql");
    }

    private static void AssertNoDependencies(string assemblyName, params string[] forbiddenPrefixes)
    {
        var references = Assembly.Load(assemblyName).GetReferencedAssemblies();
        Assert.DoesNotContain(references, reference => forbiddenPrefixes.Any(prefix =>
            reference.Name!.StartsWith(prefix, StringComparison.Ordinal)));
    }

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
            if (File.Exists(Path.Combine(directory.FullName, "CosmeticsShop.slnx"))) return directory.FullName;
        throw new InvalidOperationException("Repository root not found.");
    }
}
