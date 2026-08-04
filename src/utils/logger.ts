import winston from "winston";
import loggerConfig, { customLevels } from "@/configs/logger";

winston.addColors(customLevels.colors);

const logger = winston.createLogger({
  ...loggerConfig.create,
  ...loggerConfig.config,
  transports: loggerConfig.config.transports,
});

export default logger;
