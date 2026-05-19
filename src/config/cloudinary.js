const cloudinary = require("cloudinary").v2;

function initCloudinary() {
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    return cloudinary;
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });

  return cloudinary;
}

module.exports = {
  cloudinary,
  initCloudinary
};
