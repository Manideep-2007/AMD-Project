# Security Policy

## Docker Security Measures

### Base Images
- **Node.js 22 LTS**: Using `node:22-bookworm-slim` for latest security patches
- **Debian Bookworm**: Stable Debian release with regular security updates
- **Slim Images**: Minimal attack surface with fewer packages

### Security Hardening
1. **Security Updates**: All base images updated with latest security patches via `apt-get upgrade`
2. **Non-Root User**: Applications run as `nexusops` user (UID/GID managed by system)
3. **Multi-Stage Builds**: Separate build and runtime stages to minimize final image size
4. **Minimal Dependencies**: Only production dependencies in runtime images
5. **Health Checks**: Liveness probes for API and Proxy services
6. **File Permissions**: All application files owned by non-root user

### Known Vulnerabilities
VS Code Docker extension may report vulnerabilities in base images. These are:
- **Upstream vulnerabilities**: Issues in Debian/Node.js repositories
- **Mitigated**: Security updates applied during build
- **Monitored**: Base images updated regularly with new releases

## Reporting a Vulnerability

If you discover a security vulnerability within NexusOps, please send an e-mail via GitHub issues. All security vulnerabilities will be promptly addressed.

## Security Best Practices

### Production Deployment
1. **Environment Variables**: Never commit `.env` files with secrets
2. **Database**: Use strong passwords and connection encryption
3. **API Keys**: Rotate keys regularly, use secrets management
4. **Network**: Deploy behind reverse proxy (nginx/Traefik)
5. **TLS**: Enable HTTPS/SSL for all external endpoints
6. **Rate Limiting**: Configure in Fastify for API protection
7. **CORS**: Restrict allowed origins in production

### Monitoring
- Enable audit logging for all policy decisions
- Monitor failed authentication attempts
- Track API rate limit violations
- Review security patches monthly

## Compliance

This platform implements:
- **Audit Logging**: All agent actions logged to database
- **Policy Engine**: Rule-based access control
- **Data Encryption**: Secrets encrypted at rest
- **Access Control**: Role-based permissions

## Contact

For security concerns, please use GitHub Security Advisories or create a private issue.
