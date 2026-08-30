function familyPrefix(modelId) {
  return modelId.match(/^[^\d]*/)[0];
}

export function findSiblingModels(configuredModel, liveModels) {
  const prefix = familyPrefix(configuredModel);
  return liveModels.filter((id) => id !== configuredModel && familyPrefix(id) === prefix);
}
