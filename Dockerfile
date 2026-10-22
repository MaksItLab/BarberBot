FROM node:24-bookworm-slim AS frontend
WORKDIR /work/frontend
RUN npm install --global pnpm@11.25.0
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS backend
WORKDIR /work
COPY global.json ./
COPY backend/CosmeticsShop.Api/CosmeticsShop.Api.csproj backend/CosmeticsShop.Api/packages.lock.json backend/CosmeticsShop.Api/
COPY backend/CosmeticsShop.Domain/CosmeticsShop.Domain.csproj backend/CosmeticsShop.Domain/packages.lock.json backend/CosmeticsShop.Domain/
COPY backend/CosmeticsShop.Contracts/CosmeticsShop.Contracts.csproj backend/CosmeticsShop.Contracts/packages.lock.json backend/CosmeticsShop.Contracts/
COPY backend/CosmeticsShop.Application/CosmeticsShop.Application.csproj backend/CosmeticsShop.Application/packages.lock.json backend/CosmeticsShop.Application/
COPY backend/CosmeticsShop.Infrastructure/CosmeticsShop.Infrastructure.csproj backend/CosmeticsShop.Infrastructure/packages.lock.json backend/CosmeticsShop.Infrastructure/
RUN dotnet restore backend/CosmeticsShop.Api/CosmeticsShop.Api.csproj --locked-mode
COPY backend/ backend/
RUN dotnet publish backend/CosmeticsShop.Api/CosmeticsShop.Api.csproj -c Release --no-restore -o /out
COPY --from=frontend /work/frontend/dist/ /out/wwwroot/

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=backend /out/ ./
ENV ASPNETCORE_HTTP_PORTS=8080
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "CosmeticsShop.Api.dll"]
