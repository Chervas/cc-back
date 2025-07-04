// /home/ubuntu/backendclinicaclick/ecosystem.config.js
module.exports = {
  apps : [{
    name: "clinicaclick-auth",
    script: "src/app.js",
    instances: 1,
    autorestart: true,
    watch: true,
    ignore_watch: ["node_modules", "logs", "*.log"],
    max_memory_restart: "1G",
    
    // AÑADIR ESTA LÍNEA:
    env_file: ".env", // Ruta al archivo .env desde el cwd (que es /home/ubuntu/backendclinicaclick/)

    env: {
      NODE_ENV: "development",
    },
    env_production: {
      NODE_ENV: "production",
    }
  }]
};
